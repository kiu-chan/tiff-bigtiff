import type { ByteRange, MainToWorker, TileSpec, ToneMode, WorkerToMain } from '../shared/protocol';
import { MessageSource } from './messageSource';
import {
  CancelledError,
  chooseLevel,
  computeStats,
  openTiff,
  readPixel,
  readRegion,
  toRGBA,
  type OpenedTiff,
  type RegionResult,
} from './tiff';

const scope = self as unknown as {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
};

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

// ---------------------------------------------------------------------------
// Byte access through the webview / extension host
// ---------------------------------------------------------------------------

let nextReadId = 1;
const pendingReads = new Map<number, { resolve: (data: ArrayBuffer[]) => void; reject: (error: Error) => void }>();

function requestBytes(ranges: ByteRange[]): Promise<ArrayBuffer[]> {
  const id = nextReadId++;
  return new Promise((resolve, reject) => {
    pendingReads.set(id, { resolve, reject });
    post({ type: 'read', id, ranges });
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let opened: Promise<OpenedTiff> | undefined;

type TilesMessage = Extract<MainToWorker, { type: 'tiles' }>;

interface Job {
  generation: number;
  page: number;
  tone: ToneMode;
  spec: TileSpec;
  cancelled: boolean;
  /** Set while the tile is not wanted; the job waits before its next batch. */
  paused: boolean;
  resume?: () => void;
}

/** Display tiles rendered at the same time (tile decodes are limited separately). */
const CONCURRENCY = 6;
/** Unwanted tiles kept half-done, in case the view comes back (e.g. zooming out again). */
const MAX_PAUSED = 8;
/** Show a partial tile after this long, then at most this often. */
const FIRST_SNAPSHOT_MS = 600;
const SNAPSHOT_INTERVAL_MS = 1500;

let wanted: TilesMessage | undefined;
/** Position of each wanted tile in the list: its urgency. */
let rank = new Map<string, number>();
let queue: TileSpec[] = [];
const running = new Map<string, Job>();
const paused = new Map<string, Job>();

/** Decoded samples of recently rendered tiles, so that changing the tone only re-maps colours. */
const rawCache = new Map<string, RegionResult>();
let rawCacheBytes = 0;
const RAW_CACHE_BYTES = 128 * 1024 * 1024;

function rawKey(page: number, spec: TileSpec): string {
  return `${page}|${spec.window.join(',')}|${spec.outWidth}x${spec.outHeight}`;
}

function rawGet(key: string): RegionResult | undefined {
  const value = rawCache.get(key);
  if (value) {
    rawCache.delete(key);
    rawCache.set(key, value);
  }
  return value;
}

function rawPut(key: string, value: RegionResult): void {
  const bytes = value.data.reduce((sum, band) => sum + (band as Uint8Array).byteLength, 0);
  if (bytes > RAW_CACHE_BYTES / 4 || rawCache.has(key)) {
    return;
  }
  rawCache.set(key, value);
  rawCacheBytes += bytes;
  for (const [oldKey, old] of rawCache) {
    if (rawCacheBytes <= RAW_CACHE_BYTES) break;
    rawCache.delete(oldKey);
    rawCacheBytes -= old.data.reduce((sum, band) => sum + (band as Uint8Array).byteLength, 0);
  }
}

function cancel(job: Job): void {
  job.cancelled = true;
  job.resume?.();
}

function setWanted(message: TilesMessage): void {
  const changed = !wanted || wanted.generation !== message.generation;
  wanted = message;
  rank = new Map(message.tiles.map((t, i) => [t.id, i]));
  for (const job of [...running.values()]) {
    if (changed) {
      cancel(job);
      running.delete(job.spec.id);
    } else if (!rank.has(job.spec.id)) {
      // Keep the work done so far; resume if the tile is wanted again.
      job.paused = true;
      running.delete(job.spec.id);
      paused.set(job.spec.id, job);
    }
  }
  for (const job of [...paused.values()]) {
    if (changed || paused.size > MAX_PAUSED) {
      cancel(job);
      paused.delete(job.spec.id);
    }
  }
  queue = message.tiles.filter((t) => !running.has(t.id));
  pump();
}

function pump(): void {
  while (running.size < CONCURRENCY && queue.length && wanted) {
    const spec = queue.shift()!;
    const halfDone = paused.get(spec.id);
    if (halfDone) {
      paused.delete(spec.id);
      halfDone.paused = false;
      running.set(spec.id, halfDone);
      halfDone.resume?.();
      continue;
    }
    const job: Job = {
      generation: wanted.generation,
      page: wanted.page,
      tone: wanted.tone,
      spec,
      cancelled: false,
      paused: false,
    };
    running.set(spec.id, job);
    void renderTile(job)
      .catch((error: unknown) => {
        if (!(error instanceof CancelledError) && !job.cancelled) {
          post({ type: 'tileError', generation: job.generation, id: spec.id, message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (running.get(spec.id) === job) {
          running.delete(spec.id);
        }
        if (paused.get(spec.id) === job) {
          paused.delete(spec.id);
        }
        pump();
      });
  }
}

/** Longest side of the overview used for contrast statistics, and the most tiles it may read. */
const STATS_SIZE = 512;
const STATS_MAX_TILES = 4096;
const statsReady = new Map<number, Promise<void>>();

/**
 * Contrast stretching needs statistics of the whole page, not of each tile,
 * so that tiles match. They come from an overview that reads few tiles.
 */
function ensureStats(tiff: OpenedTiff, index: number): Promise<void> {
  const page = tiff.pages[index];
  if (!page.info.toneAdjustable || page.stats) {
    return Promise.resolve();
  }
  let ready = statsReady.get(index);
  if (!ready) {
    ready = (async () => {
      const { width, height } = page.info;
      let size = Math.min(STATS_SIZE, Math.max(width, height));
      for (;;) {
        const w = Math.max(1, Math.round((width * size) / Math.max(width, height)));
        const h = Math.max(1, Math.round((height * size) / Math.max(width, height)));
        const { image, window } = chooseLevel(page, [0, 0, width, height], w);
        const across = Math.min(w, Math.ceil(image.getWidth() / image.getTileWidth()));
        const down = Math.min(h, Math.ceil(image.getHeight() / image.getTileHeight()));
        if (across * down <= STATS_MAX_TILES || size <= 32) {
          const region = await readRegion(page, image, window, w, h);
          page.stats = computeStats(page, region.data);
          return;
        }
        size /= 2;
      }
    })();
    ready.catch(() => statsReady.delete(index));
    statsReady.set(index, ready);
  }
  return ready;
}

async function renderTile(job: Job): Promise<void> {
  const { spec, generation } = job;
  const tiff = await opened!;
  const page = tiff.pages[job.page];
  if (!page) {
    throw new Error(`Page ${job.page + 1} does not exist.`);
  }
  if (page.info.unsupported) {
    throw new Error(page.info.unsupported);
  }
  await ensureStats(tiff, job.page);
  const { outWidth, outHeight } = spec;
  const send = (data: RegionResult['data'], rows: number, final: boolean) => {
    if (job.cancelled) {
      throw new CancelledError();
    }
    const rgba = toRGBA(page, data, rows * outWidth, job.tone, new Uint8ClampedArray(outWidth * outHeight * 4));
    post(
      { type: 'tile', generation, id: spec.id, width: outWidth, height: outHeight, rgba: rgba.buffer as ArrayBuffer, final },
      [rgba.buffer as ArrayBuffer],
    );
  };

  const key = rawKey(job.page, spec);
  let region = rawGet(key);
  if (!region) {
    const { image, window } = chooseLevel(page, spec.window, outWidth);
    let lastProgress = 0;
    let lastSnapshot = Date.now() - SNAPSHOT_INTERVAL_MS + FIRST_SNAPSHOT_MS;
    region = await readRegion(page, image, window, outWidth, outHeight, {
      isCancelled: () => job.cancelled,
      waitTurn: () =>
        job.paused && !job.cancelled
          ? new Promise<void>((resolve) => {
              job.resume = resolve;
            })
          : undefined,
      priority: () => rank.get(spec.id) ?? Infinity,
      onProgress: (done, total) => {
        const now = Date.now();
        if (done === total || now - lastProgress > 200) {
          lastProgress = now;
          post({ type: 'progress', generation, id: spec.id, done, total });
        }
      },
      onRows: (rows, snapshot) => {
        const now = Date.now();
        if (rows >= outHeight || now - lastSnapshot < SNAPSHOT_INTERVAL_MS) return;
        lastSnapshot = now;
        send(snapshot(), rows, false);
      },
    });
    rawPut(key, region);
  }
  send(region.data, outHeight, true);
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const unknownCompression = /Unknown compression method identifier: (\d+)/.exec(text);
  if (unknownCompression) {
    return `Compression method ${unknownCompression[1]} is not supported.`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Pixel value readout (one request in flight, newest wins)
// ---------------------------------------------------------------------------

let pixelBusy = false;
let pixelNext: Extract<MainToWorker, { type: 'pixel' }> | undefined;

async function handlePixel(message: Extract<MainToWorker, { type: 'pixel' }>): Promise<void> {
  if (pixelBusy) {
    pixelNext = message;
    return;
  }
  pixelBusy = true;
  try {
    const tiff = await opened!;
    const page = tiff.pages[message.page];
    const values = page && !page.info.unsupported ? await readPixel(page, message.x, message.y) : null;
    post({ type: 'pixel', reqId: message.reqId, x: message.x, y: message.y, values });
  } catch {
    post({ type: 'pixel', reqId: message.reqId, x: message.x, y: message.y, values: null });
  } finally {
    pixelBusy = false;
    const next = pixelNext;
    pixelNext = undefined;
    if (next) {
      void handlePixel(next);
    }
  }
}

// ---------------------------------------------------------------------------

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'open': {
      const source = new MessageSource(message.fileSize, requestBytes);
      opened = openTiff(source);
      opened.then(
        (tiff) => post({ type: 'opened', info: tiff.info }),
        (error) => post({ type: 'openError', message: errorMessage(error) }),
      );
      break;
    }
    case 'readResult':
      pendingReads.get(message.id)?.resolve(message.data);
      pendingReads.delete(message.id);
      break;
    case 'readError':
      pendingReads.get(message.id)?.reject(new Error(message.message));
      pendingReads.delete(message.id);
      break;
    case 'tiles':
      setWanted(message);
      break;
    case 'pixel':
      void handlePixel(message);
      break;
  }
};
