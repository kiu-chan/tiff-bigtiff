import type { ByteRange, MainToWorker, WorkerToMain } from '../shared/protocol';
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

type RenderMessage = Extract<MainToWorker, { type: 'render' }>;

interface Job {
  message: RenderMessage;
  cancelled: boolean;
}

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
let queue: Job[] = [];
let running: Job | undefined;

/** Recently decoded regions, so that changing the contrast mode does not decode again. */
const rawCache: { key: string; value: RegionResult }[] = [];
const RAW_CACHE_SIZE = 3;

function cacheGet(key: string): RegionResult | undefined {
  const index = rawCache.findIndex((entry) => entry.key === key);
  if (index < 0) {
    return undefined;
  }
  const [entry] = rawCache.splice(index, 1);
  rawCache.push(entry);
  return entry.value;
}

function cachePut(key: string, value: RegionResult): void {
  rawCache.push({ key, value });
  if (rawCache.length > RAW_CACHE_SIZE) {
    rawCache.shift();
  }
}

function enqueue(message: RenderMessage): void {
  for (const job of [...queue, ...(running ? [running] : [])]) {
    // A new preview (page change, reload) supersedes everything; a new detail supersedes older details.
    if (message.kind === 'preview' || job.message.kind === 'detail') {
      job.cancelled = true;
    }
  }
  queue = queue.filter((job) => !job.cancelled);
  queue.push({ message, cancelled: false });
  void pump();
}

async function pump(): Promise<void> {
  if (running) {
    return;
  }
  while (queue.length) {
    const job = queue.shift()!;
    running = job;
    try {
      await render(job);
    } catch (error) {
      if (!(error instanceof CancelledError)) {
        const { reqId, kind, page } = job.message;
        post({ type: 'renderError', reqId, kind, page, message: errorMessage(error) });
      }
    } finally {
      running = undefined;
    }
  }
}

async function render(job: Job): Promise<void> {
  const { message } = job;
  const tiff = await opened!;
  const page = tiff.pages[message.page];
  if (!page) {
    throw new Error(`Page ${message.page + 1} does not exist.`);
  }
  if (page.info.unsupported) {
    throw new Error(page.info.unsupported);
  }
  const { image, window } = chooseLevel(page, message.window, message.outWidth);
  const key = `${message.page}|${page.images.indexOf(image)}|${window.join(',')}|${message.outWidth}x${message.outHeight}`;
  let region = cacheGet(key);
  if (!region) {
    let lastProgress = 0;
    region = await readRegion(
      page,
      image,
      window,
      message.outWidth,
      message.outHeight,
      () => job.cancelled,
      (done, total) => {
        const now = Date.now();
        if (done === total || now - lastProgress > 100) {
          lastProgress = now;
          post({ type: 'progress', reqId: message.reqId, kind: message.kind, done, total });
        }
      },
    );
    cachePut(key, region);
  }
  if (job.cancelled) {
    throw new CancelledError();
  }
  if (page.info.toneAdjustable) {
    // The preview covers the whole page and is always rendered first.
    page.stats ??= computeStats(page, region.data);
  }
  const rgba = toRGBA(page, region.data, region.width * region.height, message.tone);
  post(
    {
      type: 'rendered',
      reqId: message.reqId,
      kind: message.kind,
      page: message.page,
      window: message.window,
      width: region.width,
      height: region.height,
      rgba: rgba.buffer as ArrayBuffer,
    },
    [rgba.buffer as ArrayBuffer],
  );
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
    case 'render':
      enqueue(message);
      break;
    case 'pixel':
      void handlePixel(message);
      break;
  }
};
