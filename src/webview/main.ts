import type {
  FileInfo,
  HostToWebview,
  MainToWorker,
  PageInfo,
  PixelWindow,
  TileSpec,
  ToneMode,
  WebviewToHost,
  WorkerToMain,
} from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };
declare global {
  interface Window {
    TIFF_WORKER_URL: string;
  }
}

/**
 * The image is shown as a pyramid of display tiles: at level z one tile pixel
 * spans 2^z image pixels, and a tile is TILE_SIZE pixels square. Only tiles in
 * view are rendered, at the level that matches the zoom; coarser tiles already
 * loaded fill in while finer ones arrive.
 */
const TILE_SIZE = 512;
/** The coarsest level shows the whole page at most this large. It is loaded first. */
const TOP_SIZE = 32;
/**
 * Coarser levels are loaded before the level the view needs only when they
 * need at most this fraction of its data, so that they add little work.
 */
const COARSE_LEVEL_SHARE = 1 / 8;
/** Rendered tiles kept, in pixels (4 bytes each). */
const TILE_CACHE_PIXELS = 64 * 1024 * 1024;
const MAX_ZOOM = 64;
const ZOOM_STEP = 1.25;

const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const pageGroup = $<HTMLLabelElement>('pageGroup');
const pageSelect = $<HTMLSelectElement>('page');
const toneGroup = $<HTMLLabelElement>('toneGroup');
const toneSelect = $<HTMLSelectElement>('tone');
const zoomLabel = $<HTMLSpanElement>('zoomLabel');
const infoToggle = $<HTMLButtonElement>('infoToggle');
const infoPanel = $<HTMLElement>('info');
const progress = $<HTMLDivElement>('progress');
const progressBar = $<HTMLDivElement>('progressBar');
const messageBox = $<HTMLDivElement>('message');
const statusSize = $<HTMLSpanElement>('statusSize');
const statusProgress = $<HTMLSpanElement>('statusProgress');
const statusPos = $<HTMLSpanElement>('statusPos');
const statusValue = $<HTMLSpanElement>('statusValue');

interface DisplayTile {
  z: number;
  window: PixelWindow;
  bitmap: ImageBitmap;
  final: boolean;
  /** Tiles of an older generation (before a tone change) are shown until replaced. */
  generation: number;
  used: number;
}

let worker: Worker | undefined;
let fileName = '';
let info: FileInfo | undefined;
/** Rough compressed size of one pixel, to estimate how much a view needs to read. */
let bytesPerPixel = 1;
let pageIndex = 0;
let tone: ToneMode = 'minmax';

/** Screen (CSS) pixels per image pixel, and the screen position of the image origin. */
const view = { scale: 1, tx: 0, ty: 0 };
/** 'auto': fit but never enlarge; 'fit': fit to window; undefined: user zoom. */
let fitMode: 'auto' | 'fit' | undefined = 'auto';

/** Changes with the page or tone; rendering results of other generations are stale. */
let generation = 0;
const tiles = new Map<string, DisplayTile>();
let tilePixels = 0;
let drawCounter = 0;
/** Tiles asked from the worker for the current view, with their progress in source tiles. */
let requested = new Map<string, { done: number; total: number }>();
let lastRequest = '';
const failed = new Set<string>();
/** Level the current view is rendered at. */
let viewLevel = 0;
let tilesTimer: ReturnType<typeof setTimeout> | undefined;
let requestCounter = 0;
let pixelReq = 0;
/** Dimensions of the page last shown, to keep the view across file reloads. */
let shownSize = '';

function currentPage(): PageInfo | undefined {
  return info?.pages[pageIndex];
}

function postToWorker(message: MainToWorker, transfer: Transferable[] = []): void {
  worker?.postMessage(message, transfer);
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

async function createWorker(): Promise<Worker> {
  // Webview resources are cross-origin for Worker(), so start it from a blob URL.
  const response = await fetch(window.TIFF_WORKER_URL);
  const code = await response.text();
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  w.onmessage = (event: MessageEvent<WorkerToMain>) => void onWorkerMessage(event.data);
  w.onerror = (event) => showMessage(`Decoder error: ${event.message}`);
  return w;
}

async function start(fileSize: number): Promise<void> {
  worker?.terminate();
  worker = undefined;
  info = undefined;
  clearTiles();
  showMessage(undefined);
  showProgress(undefined);
  if (fileSize === 0) {
    showMessage('The file is empty.');
    return;
  }
  try {
    worker = await createWorker();
  } catch (error) {
    showMessage(`Could not start the decoder: ${String(error)}`);
    return;
  }
  postToWorker({ type: 'open', fileSize });
}

function clearTiles(): void {
  for (const tile of tiles.values()) {
    tile.bitmap.close();
  }
  tiles.clear();
  tilePixels = 0;
  generation++;
  requested = new Map();
  lastRequest = '';
  failed.clear();
  draw();
}

async function onWorkerMessage(message: WorkerToMain): Promise<void> {
  switch (message.type) {
    case 'read':
      vscode.postMessage({ type: 'read', id: message.id, ranges: message.ranges });
      break;
    case 'opened': {
      info = message.info;
      const pixels = info.pages.reduce((sum, p) => sum + p.levels.reduce((s, l) => s + l.width * l.height, 0), 0);
      bytesPerPixel = pixels ? info.fileSize / pixels : 1;
      setupPages();
      selectPage(Math.min(pageIndex, info.pages.length - 1), true);
      break;
    }
    case 'openError':
      showProgress(undefined);
      showMessage(`Cannot open ${fileName}: ${message.message}`);
      break;
    case 'progress': {
      const entry = message.generation === generation ? requested.get(message.id) : undefined;
      if (entry) {
        entry.done = message.done;
        entry.total = message.total;
        updateProgress();
      }
      break;
    }
    case 'tile':
      await onTile(message);
      break;
    case 'tileError':
      if (message.generation === generation) {
        failed.add(message.id);
        requested.delete(message.id);
        updateProgress();
        if (![...tiles.values()].some((t) => t.generation === generation)) {
          showMessage(message.message);
        }
      }
      break;
    case 'pixel':
      if (message.reqId === pixelReq) {
        statusValue.textContent = formatValues(message.values);
      }
      break;
  }
}

async function onTile(message: Extract<WorkerToMain, { type: 'tile' }>): Promise<void> {
  if (message.generation !== generation) {
    return;
  }
  const image = new ImageData(new Uint8ClampedArray(message.rgba), message.width, message.height);
  const bitmap = await createImageBitmap(image);
  const page = currentPage();
  if (message.generation !== generation || !page) {
    bitmap.close();
    return;
  }
  const [z, i, j] = message.id.split('/').map(Number);
  const old = tiles.get(message.id);
  if (old) {
    old.bitmap.close();
    tilePixels -= old.bitmap.width * old.bitmap.height;
  }
  tiles.set(message.id, {
    z,
    window: tileWindow(page, z, i, j),
    bitmap,
    final: message.final,
    generation,
    used: ++drawCounter,
  });
  tilePixels += bitmap.width * bitmap.height;
  if (message.final) {
    const entry = requested.get(message.id);
    if (entry) entry.done = entry.total;
    updateProgress();
    showMessage(undefined);
  }
  evictTiles();
  draw();
}

/** Drops the least recently drawn tiles beyond the cache size (never the overview). */
function evictTiles(): void {
  if (tilePixels <= TILE_CACHE_PIXELS) {
    return;
  }
  const page = currentPage();
  const top = page ? topLevel(page) : Infinity;
  const byAge = [...tiles.entries()].filter(([, t]) => t.z !== top).sort((a, b) => a[1].used - b[1].used);
  for (const [id, tile] of byAge) {
    if (tilePixels <= TILE_CACHE_PIXELS) break;
    tile.bitmap.close();
    tilePixels -= tile.bitmap.width * tile.bitmap.height;
    tiles.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Pages and tiles
// ---------------------------------------------------------------------------

function setupPages(): void {
  const pages = info!.pages;
  pageSelect.replaceChildren(
    ...pages.map((page, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `${i + 1} / ${pages.length}  (${page.width} × ${page.height})`;
      return option;
    }),
  );
  pageGroup.hidden = pages.length < 2;
}

function selectPage(index: number, keepView = false): void {
  const page = info?.pages[index];
  if (!page) {
    showMessage('This file contains no images.');
    return;
  }
  const size = `${page.width}x${page.height}`;
  const sameSize = keepView && size === shownSize;
  shownSize = size;
  pageIndex = index;
  pageSelect.value = String(index);
  clearTiles();
  showMessage(undefined);

  toneGroup.hidden = !page.toneAdjustable;
  const fullOption = toneSelect.querySelector<HTMLOptionElement>('option[value="full"]')!;
  fullOption.hidden = !page.fullRangeAvailable;
  if (tone === 'full' && !page.fullRangeAvailable) {
    tone = 'minmax';
  }
  toneSelect.value = tone;

  statusSize.textContent = `${page.width} × ${page.height}`;
  renderInfo();

  if (!sameSize) {
    fitMode = 'auto';
  }
  if (page.unsupported) {
    showProgress(undefined);
    showMessage(page.unsupported);
  } else {
    showProgress(0, 'Loading');
  }
  layout(0);
}

function setTone(value: ToneMode): void {
  tone = value;
  // Keep the tiles on screen until they are replaced; the worker still has the
  // decoded samples of recent tiles, so this only re-maps colours.
  generation++;
  requested = new Map();
  lastRequest = '';
  failed.clear();
  scheduleTiles(0);
}

function topLevel(page: PageInfo): number {
  return Math.max(0, Math.ceil(Math.log2(Math.max(page.width, page.height) / TOP_SIZE)));
}

function tileWindow(page: PageInfo, z: number, i: number, j: number): PixelWindow {
  const span = TILE_SIZE * 2 ** z;
  return [i * span, j * span, Math.min(page.width, (i + 1) * span), Math.min(page.height, (j + 1) * span)];
}

function tileSpec(page: PageInfo, z: number, i: number, j: number): TileSpec {
  const window = tileWindow(page, z, i, j);
  const f = 2 ** z;
  return {
    id: `${z}/${i}/${j}`,
    window,
    outWidth: Math.max(1, Math.ceil((window[2] - window[0]) / f)),
    outHeight: Math.max(1, Math.ceil((window[3] - window[1]) / f)),
  };
}

/** Image area in view, in full-resolution pixels. */
function visibleWindow(page: PageInfo): PixelWindow | undefined {
  const s = view.scale;
  const visible: PixelWindow = [
    Math.max(0, Math.floor(-view.tx / s)),
    Math.max(0, Math.floor(-view.ty / s)),
    Math.min(page.width, Math.ceil((stage.clientWidth - view.tx) / s)),
    Math.min(page.height, Math.ceil((stage.clientHeight - view.ty) / s)),
  ];
  return visible[2] > visible[0] && visible[3] > visible[1] ? visible : undefined;
}

/** Tiles of level z overlapping `visible`, nearest to its centre first. */
function tilesInView(page: PageInfo, z: number, visible: PixelWindow): TileSpec[] {
  const span = TILE_SIZE * 2 ** z;
  const cx = (visible[0] + visible[2]) / 2;
  const cy = (visible[1] + visible[3]) / 2;
  const specs: { spec: TileSpec; d: number }[] = [];
  for (let j = Math.floor(visible[1] / span); j < Math.ceil(visible[3] / span); j++) {
    for (let i = Math.floor(visible[0] / span); i < Math.ceil(visible[2] / span); i++) {
      const d = Math.hypot((i + 0.5) * span - cx, (j + 0.5) * span - cy);
      specs.push({ spec: tileSpec(page, z, i, j), d });
    }
  }
  return specs.sort((a, b) => a.d - b.d).map((s) => s.spec);
}

/**
 * Estimated file tiles (or strips) a display tile needs, and their bytes. It
 * mirrors the worker: the smallest pyramid level with enough resolution, and
 * at most one file tile per output pixel when sampling sparsely.
 */
function estimate(page: PageInfo, spec: TileSpec): { tiles: number; bytes: number } {
  const [x0, y0, x1, y1] = spec.window;
  const scale = spec.outWidth / (x1 - x0);
  let level = page.levels[0];
  for (const candidate of page.levels) {
    if (candidate.width / page.width >= scale * 0.98) level = candidate;
  }
  const fx = level.width / page.width;
  const fy = level.height / page.height;
  const across = Math.ceil((x1 * fx) / level.tileWidth) - Math.floor((x0 * fx) / level.tileWidth);
  const down = Math.ceil((y1 * fy) / level.tileHeight) - Math.floor((y0 * fy) / level.tileHeight);
  const count = Math.min(across, spec.outWidth) * Math.min(down, spec.outHeight);
  return { tiles: count, bytes: count * level.tileWidth * level.tileHeight * bytesPerPixel };
}

function scheduleTiles(delay = 120): void {
  clearTimeout(tilesTimer);
  tilesTimer = setTimeout(updateTiles, delay);
}

/** Asks the worker for the tiles the current view needs, coarse levels first. */
function updateTiles(): void {
  const page = currentPage();
  if (!page || page.unsupported || !worker) {
    return;
  }
  const visible = visibleWindow(page);
  if (!visible) {
    return;
  }
  const top = topLevel(page);
  const levelCost = new Map<number, number>();
  const cost = (z: number) => {
    let bytes = levelCost.get(z);
    if (bytes === undefined) {
      bytes = tilesInView(page, z, visible).reduce((sum, spec) => sum + estimate(page, spec).bytes, 0);
      levelCost.set(z, bytes);
    }
    return bytes;
  };
  // Always the full sharpness the zoom needs, however much data that is.
  const z = Math.min(top, Math.max(0, Math.floor(Math.log2(1 / (view.scale * devicePixelRatio)))));
  if (z !== viewLevel) {
    viewLevel = z;
    draw();
  }

  // The overview first, then coarser levels that cost much less than the
  // target level (they show something quickly), then the target level.
  // A huge image without overviews needs every file tile when zoomed out;
  // the coarse levels only sample some of them.
  const levels = [top];
  for (let l = top - 1; l > z; l--) {
    if (cost(l) <= cost(z) * COARSE_LEVEL_SHARE) levels.push(l);
  }
  if (z < top) levels.push(z);

  const list: TileSpec[] = [];
  for (const l of levels) {
    for (const spec of tilesInView(page, l, l === top ? [0, 0, page.width, page.height] : visible)) {
      const tile = tiles.get(spec.id);
      if ((tile?.final && tile.generation === generation) || failed.has(spec.id)) continue;
      list.push(spec);
    }
  }
  const key = `${generation}|${list.map((s) => s.id).join(',')}`;
  if (key === lastRequest) {
    return;
  }
  lastRequest = key;
  const previous = requested;
  requested = new Map(
    list.map((spec) => [spec.id, previous.get(spec.id) ?? { done: 0, total: Math.max(1, estimate(page, spec).tiles) }]),
  );
  updateProgress();
  postToWorker({ type: 'tiles', generation, page: pageIndex, tone, tiles: list });
}

function updateProgress(): void {
  let done = 0;
  let total = 0;
  for (const entry of requested.values()) {
    done += entry.done;
    total += entry.total;
  }
  showProgress(total && done < total ? done / total : undefined, 'Loading');
}

// ---------------------------------------------------------------------------
// View transform
// ---------------------------------------------------------------------------

function fitScale(): number {
  const page = currentPage();
  if (!page) {
    return 1;
  }
  return Math.min(stage.clientWidth / page.width, stage.clientHeight / page.height);
}

function minScale(): number {
  return Math.min(fitScale() * 0.5, 1);
}

function maxScale(): number {
  return Math.max(MAX_ZOOM, fitScale() * 4);
}

function clampView(): void {
  const page = currentPage();
  if (!page) {
    return;
  }
  const clampAxis = (offset: number, size: number, viewport: number) =>
    size <= viewport ? (viewport - size) / 2 : Math.min(0, Math.max(viewport - size, offset));
  view.tx = clampAxis(view.tx, page.width * view.scale, stage.clientWidth);
  view.ty = clampAxis(view.ty, page.height * view.scale, stage.clientHeight);
}

function layout(delay?: number): void {
  if (fitMode) {
    const s = fitScale();
    view.scale = fitMode === 'auto' ? Math.min(1, s) : s;
  }
  clampView();
  updateZoomLabel();
  draw();
  scheduleTiles(delay);
}

function zoomTo(scale: number, anchorX = stage.clientWidth / 2, anchorY = stage.clientHeight / 2): void {
  if (!currentPage()) {
    return;
  }
  const next = Math.min(maxScale(), Math.max(minScale(), scale));
  view.tx = anchorX - ((anchorX - view.tx) * next) / view.scale;
  view.ty = anchorY - ((anchorY - view.ty) * next) / view.scale;
  view.scale = next;
  fitMode = undefined;
  layout();
}

function setFit(mode: 'auto' | 'fit'): void {
  fitMode = mode;
  layout();
}

function updateZoomLabel(): void {
  const percent = view.scale * 100;
  zoomLabel.textContent = currentPage() ? `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%` : '–';
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

let checker: CanvasPattern | undefined;
let checkerTheme = '';

function checkerPattern(): CanvasPattern {
  const light = document.body.classList.contains('vscode-light');
  const theme = light ? 'light' : 'dark';
  if (!checker || checkerTheme !== theme) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 16;
    const t = tile.getContext('2d')!;
    t.fillStyle = light ? '#ffffff' : '#3a3a3a';
    t.fillRect(0, 0, 16, 16);
    t.fillStyle = light ? '#e6e6e6' : '#2c2c2c';
    t.fillRect(0, 0, 8, 8);
    t.fillRect(8, 8, 8, 8);
    checker = ctx.createPattern(tile, 'repeat')!;
    checkerTheme = theme;
  }
  return checker;
}

function draw(): void {
  const dpr = devicePixelRatio;
  const width = Math.round(stage.clientWidth * dpr);
  const height = Math.round(stage.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const page = currentPage();
  if (!page || tiles.size === 0) {
    return;
  }
  const visible = visibleWindow(page);
  if (!visible) {
    return;
  }
  // Coarse levels first, finer ones on top. Finer tiles than the view needs
  // (left from zooming in) are drawn too, down to two levels below.
  const shown = [...tiles.values()]
    .filter(
      (t) =>
        t.z >= viewLevel - 2 &&
        t.window[0] < visible[2] &&
        t.window[2] > visible[0] &&
        t.window[1] < visible[3] &&
        t.window[3] > visible[1],
    )
    .sort((a, b) => b.z - a.z || a.generation - b.generation);
  if (page.hasAlpha) {
    const [x0, y0, x1, y1] = deviceRect(page, [0, 0, page.width, page.height]);
    ctx.fillStyle = checkerPattern();
    ctx.fillRect(Math.max(0, x0), Math.max(0, y0), Math.min(width, x1) - Math.max(0, x0), Math.min(height, y1) - Math.max(0, y0));
  }
  for (const tile of shown) {
    tile.used = ++drawCounter;
    drawTile(page, tile, width, height);
  }
}

/** Canvas (device pixel) rectangle of an image window, with edges rounded so that tiles meet exactly. */
function deviceRect(page: PageInfo, window: PixelWindow): [number, number, number, number] {
  const dpr = devicePixelRatio;
  const s = view.scale * dpr;
  const ox = view.tx * dpr;
  const oy = view.ty * dpr;
  return [
    Math.round(ox + window[0] * s),
    Math.round(oy + window[1] * s),
    Math.round(ox + window[2] * s),
    Math.round(oy + window[3] * s),
  ];
}

function drawTile(page: PageInfo, tile: DisplayTile, width: number, height: number): void {
  const [x0, y0, x1, y1] = deviceRect(page, tile.window);
  // Clip to the canvas to keep coordinates small at high zoom.
  const cx0 = Math.max(0, x0);
  const cy0 = Math.max(0, y0);
  const cx1 = Math.min(width, x1);
  const cy1 = Math.min(height, y1);
  if (cx1 <= cx0 || cy1 <= cy0) {
    return;
  }
  const bw = tile.bitmap.width;
  const bh = tile.bitmap.height;
  const sx0 = ((cx0 - x0) / (x1 - x0)) * bw;
  const sy0 = ((cy0 - y0) / (y1 - y0)) * bh;
  const sx1 = ((cx1 - x0) / (x1 - x0)) * bw;
  const sy1 = ((cy1 - y0) / (y1 - y0)) * bh;
  if (page.hasAlpha && tile.final) {
    // Do not let coarser tiles show through transparent pixels.
    ctx.clearRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    ctx.fillStyle = checkerPattern();
    ctx.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
  }
  // Show crisp pixels when magnifying full-resolution data; smooth otherwise.
  ctx.imageSmoothingEnabled = !(tile.z === 0 && view.scale * devicePixelRatio >= 1);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tile.bitmap, sx0, sy0, sx1 - sx0, sy1 - sy0, cx0, cy0, cx1 - cx0, cy1 - cy0);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function showProgress(fraction: number | undefined, label = 'Loading'): void {
  progress.hidden = fraction === undefined;
  const percent = (fraction ?? 0) * 100;
  progressBar.style.width = `${percent}%`;
  statusProgress.textContent =
    fraction === undefined ? '' : `${label} ${percent < 10 ? percent.toFixed(1) : Math.floor(percent)}%`;
}

function showMessage(text: string | undefined): void {
  messageBox.hidden = !text;
  messageBox.textContent = text ?? '';
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  return Number(value.toPrecision(6)).toString();
}

function formatValues(values: number[] | null): string {
  const page = currentPage();
  if (!values || !page) {
    return '';
  }
  if (values.length === 1) {
    return `${page.sampleLabels[0]}: ${formatNumber(values[0])}`;
  }
  return values.map((v, i) => `${page.sampleLabels[i] ?? `S${i}`} ${formatNumber(v)}`).join('  ');
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

function renderInfo(): void {
  const page = currentPage();
  if (!info || !page) {
    infoPanel.replaceChildren();
    return;
  }
  const section = (title: string, rows: [string, string][]) => {
    const h = document.createElement('h3');
    h.textContent = title;
    const dl = document.createElement('dl');
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
    return [h, dl];
  };
  const fileRows: [string, string][] = [
    ['Name', fileName],
    ['Format', info.bigTiff ? 'BigTIFF (64-bit offsets)' : 'TIFF (32-bit offsets)'],
    ['Byte order', info.littleEndian ? 'Little-endian (II)' : 'Big-endian (MM)'],
    ['File size', formatBytes(info.fileSize)],
    ['Images (IFDs)', String(info.ifdCount)],
    ['Pages', String(info.pages.length)],
  ];
  const pageRows: [string, string][] = [
    ['Dimensions', `${page.width} × ${page.height}`],
    ['Samples per pixel', `${page.samplesPerPixel} (${page.sampleLabels.join(', ')})`],
    ['Bits per sample', page.bitsPerSample.join(', ')],
    ['Sample format', page.sampleFormat],
    ['Photometric', page.photometric],
    ['Compression', page.compression],
    ['Planar config', page.planar],
    ['Layout', page.layout],
  ];
  if (page.levels.length > 1) {
    pageRows.push(['Pyramid levels', page.levels.map((l) => `${l.width}×${l.height}`).join(', ')]);
  }
  if (page.noData !== null) {
    pageRows.push(['NoData', String(page.noData)]);
  }
  infoPanel.replaceChildren(
    ...section('File', fileRows),
    ...section(info.pages.length > 1 ? `Page ${pageIndex + 1}` : 'Image', pageRows),
    ...(page.tags.length ? section('Tags', page.tags) : []),
  );
}

function toggleInfo(): void {
  infoPanel.hidden = !infoPanel.hidden;
  infoToggle.setAttribute('aria-pressed', String(!infoPanel.hidden));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

let drag: { x: number; y: number; id: number } | undefined;

function stagePoint(event: MouseEvent): [number, number] {
  const rect = stage.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

stage.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const lineScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      const [x, y] = stagePoint(event);
      const delta = Math.max(-100, Math.min(100, event.deltaY * lineScale));
      zoomTo(view.scale * Math.exp(-delta * 0.01), x, y);
    } else {
      view.tx -= event.deltaX * lineScale;
      view.ty -= event.deltaY * lineScale;
      clampView();
      draw();
      scheduleTiles();
    }
  },
  { passive: false },
);

stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.button !== 1) {
    return;
  }
  stage.focus();
  drag = { x: event.clientX, y: event.clientY, id: event.pointerId };
  stage.setPointerCapture(event.pointerId);
  stage.classList.add('dragging');
});

stage.addEventListener('pointermove', (event) => {
  if (drag && drag.id === event.pointerId) {
    view.tx += event.clientX - drag.x;
    view.ty += event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    clampView();
    draw();
    scheduleTiles();
    return;
  }
  updatePointerReadout(event);
});

const endDrag = (event: PointerEvent) => {
  if (drag && drag.id === event.pointerId) {
    drag = undefined;
    stage.classList.remove('dragging');
  }
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('pointerleave', () => {
  statusPos.textContent = '';
  statusValue.textContent = '';
  pixelReq = 0;
});

stage.addEventListener('dblclick', (event) => {
  const [x, y] = stagePoint(event);
  if (Math.abs(view.scale - Math.min(1, fitScale())) < 1e-6 || fitMode) {
    zoomTo(view.scale < 1 ? 1 : view.scale * 2, x, y);
  } else {
    setFit('auto');
  }
});

function updatePointerReadout(event: MouseEvent): void {
  const page = currentPage();
  if (!page || page.unsupported) {
    return;
  }
  const [px, py] = stagePoint(event);
  const x = Math.floor((px - view.tx) / view.scale);
  const y = Math.floor((py - view.ty) / view.scale);
  if (x < 0 || y < 0 || x >= page.width || y >= page.height) {
    statusPos.textContent = '';
    statusValue.textContent = '';
    pixelReq = 0;
    return;
  }
  statusPos.textContent = `x ${x}, y ${y}`;
  pixelReq = ++requestCounter;
  postToWorker({ type: 'pixel', reqId: pixelReq, page: pageIndex, x, y });
}

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLSelectElement || event.altKey) {
    return;
  }
  const mod = event.ctrlKey || event.metaKey;
  let handled = true;
  switch (event.key) {
    case '+':
    case '=':
      zoomTo(view.scale * ZOOM_STEP);
      break;
    case '-':
    case '_':
      zoomTo(view.scale / ZOOM_STEP);
      break;
    case '0':
      setFit('fit');
      break;
    case '1':
      zoomTo(1);
      break;
    case 'PageDown':
    case ']':
      changePage(1);
      break;
    case 'PageUp':
    case '[':
      changePage(-1);
      break;
    case 'i':
    case 'I':
      if (mod) handled = false;
      else toggleInfo();
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      const step = event.shiftKey ? 200 : 50;
      view.tx += event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0;
      view.ty += event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
      clampView();
      draw();
      scheduleTiles();
      break;
    }
    default:
      handled = false;
  }
  if (handled && !mod) {
    event.preventDefault();
  }
});

function changePage(delta: number): void {
  if (!info) {
    return;
  }
  const next = pageIndex + delta;
  if (next >= 0 && next < info.pages.length) {
    selectPage(next);
  }
}

$('zoomIn').addEventListener('click', () => zoomTo(view.scale * ZOOM_STEP));
$('zoomOut').addEventListener('click', () => zoomTo(view.scale / ZOOM_STEP));
$('fit').addEventListener('click', () => setFit('fit'));
$('actual').addEventListener('click', () => zoomTo(1));
infoToggle.addEventListener('click', toggleInfo);
pageSelect.addEventListener('change', () => selectPage(Number(pageSelect.value)));
toneSelect.addEventListener('change', () => setTone(toneSelect.value as ToneMode));

new ResizeObserver(() => layout()).observe(stage);
new MutationObserver(() => draw()).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---------------------------------------------------------------------------
// Extension host messages
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      fileName = message.fileName;
      void start(message.fileSize);
      break;
    case 'reload':
      void start(message.fileSize);
      break;
    case 'readResult': {
      const buffers = message.data.map((chunk) =>
        chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
          ? (chunk.buffer as ArrayBuffer)
          : (chunk.slice().buffer as ArrayBuffer),
      );
      postToWorker({ type: 'readResult', id: message.id, data: buffers }, buffers);
      break;
    }
    case 'readError':
      postToWorker({ type: 'readError', id: message.id, message: message.message });
      break;
  }
});

vscode.postMessage({ type: 'ready' });
