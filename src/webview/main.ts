import type {
  FileInfo,
  HostToWebview,
  MainToWorker,
  PageInfo,
  PixelWindow,
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

/** Pages up to this many pixels are previewed at full resolution. */
const FULL_RES_PIXELS = 16 * 1024 * 1024;
/** Longest side of the whole-page preview for larger pages. */
const PREVIEW_LONG_SIDE = 2048;
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
const statusPos = $<HTMLSpanElement>('statusPos');
const statusValue = $<HTMLSpanElement>('statusValue');

interface Layer {
  page: number;
  window: PixelWindow;
  bitmap: ImageBitmap;
  /** Bitmap pixels per full-resolution image pixel. */
  resolution: number;
}

let worker: Worker | undefined;
let fileName = '';
let info: FileInfo | undefined;
let pageIndex = 0;
let tone: ToneMode = 'minmax';

/** Screen (CSS) pixels per image pixel, and the screen position of the image origin. */
const view = { scale: 1, tx: 0, ty: 0 };
/** 'auto': fit but never enlarge; 'fit': fit to window; undefined: user zoom. */
let fitMode: 'auto' | 'fit' | undefined = 'auto';

let preview: Layer | undefined;
let detail: Layer | undefined;
let requestCounter = 0;
let previewReq = 0;
let detailReq = 0;
let pendingDetail: { window: PixelWindow; resolution: number } | undefined;
let detailTimer: ReturnType<typeof setTimeout> | undefined;
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
  clearLayers();
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

function clearLayers(): void {
  preview?.bitmap.close();
  detail?.bitmap.close();
  preview = undefined;
  detail = undefined;
  pendingDetail = undefined;
  draw();
}

async function onWorkerMessage(message: WorkerToMain): Promise<void> {
  switch (message.type) {
    case 'read':
      vscode.postMessage({ type: 'read', id: message.id, ranges: message.ranges });
      break;
    case 'opened':
      info = message.info;
      setupPages();
      selectPage(Math.min(pageIndex, info.pages.length - 1), true);
      break;
    case 'openError':
      showProgress(undefined);
      showMessage(`Cannot open ${fileName}: ${message.message}`);
      break;
    case 'progress':
      if (message.kind === 'preview' && message.reqId === previewReq) {
        showProgress(message.done / message.total);
      }
      break;
    case 'rendered':
      await onRendered(message);
      break;
    case 'renderError':
      if (message.kind === 'preview' && message.reqId === previewReq) {
        showProgress(undefined);
        showMessage(message.message);
      } else if (message.reqId === detailReq) {
        pendingDetail = undefined;
      }
      break;
    case 'pixel':
      if (message.reqId === pixelReq) {
        statusValue.textContent = formatValues(message.values);
      }
      break;
  }
}

async function onRendered(message: Extract<WorkerToMain, { type: 'rendered' }>): Promise<void> {
  const isPreview = message.kind === 'preview';
  if ((isPreview ? previewReq : detailReq) !== message.reqId) {
    return;
  }
  const image = new ImageData(new Uint8ClampedArray(message.rgba), message.width, message.height);
  const bitmap = await createImageBitmap(image);
  if ((isPreview ? previewReq : detailReq) !== message.reqId || message.page !== pageIndex) {
    bitmap.close();
    return;
  }
  const layer: Layer = {
    page: message.page,
    window: message.window,
    bitmap,
    resolution: message.width / (message.window[2] - message.window[0]),
  };
  if (isPreview) {
    preview?.bitmap.close();
    preview = layer;
    showProgress(undefined);
    showMessage(undefined);
    scheduleDetail(0);
  } else {
    detail?.bitmap.close();
    detail = layer;
    pendingDetail = undefined;
  }
  draw();
}

// ---------------------------------------------------------------------------
// Pages and rendering requests
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
  clearLayers();
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
  layout();

  if (page.unsupported) {
    showProgress(undefined);
    showMessage(page.unsupported);
    return;
  }
  requestPreview();
}

function requestPreview(): void {
  const page = currentPage();
  if (!page) {
    return;
  }
  let outWidth = page.width;
  let outHeight = page.height;
  if (page.width * page.height > FULL_RES_PIXELS) {
    const f = PREVIEW_LONG_SIDE / Math.max(page.width, page.height);
    outWidth = Math.max(1, Math.round(page.width * f));
    outHeight = Math.max(1, Math.round(page.height * f));
  }
  previewReq = ++requestCounter;
  detailReq = 0;
  pendingDetail = undefined;
  showProgress(0);
  postToWorker({
    type: 'render',
    reqId: previewReq,
    kind: 'preview',
    page: pageIndex,
    window: [0, 0, page.width, page.height],
    outWidth,
    outHeight,
    tone,
  });
}

function scheduleDetail(delay = 150): void {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(updateDetail, delay);
}

function covers(outer: PixelWindow, inner: PixelWindow): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

/** Requests a sharper rendering of the visible area when the preview is too coarse. */
function updateDetail(): void {
  const page = currentPage();
  if (!page || !preview || page.unsupported) {
    return;
  }
  const needed = Math.min(1, view.scale * devicePixelRatio);
  if (preview.resolution >= needed * 0.99) {
    if (detail) {
      detail.bitmap.close();
      detail = undefined;
      draw();
    }
    return;
  }
  const s = view.scale;
  const visible: PixelWindow = [
    Math.max(0, Math.floor(-view.tx / s)),
    Math.max(0, Math.floor(-view.ty / s)),
    Math.min(page.width, Math.ceil((stage.clientWidth - view.tx) / s)),
    Math.min(page.height, Math.ceil((stage.clientHeight - view.ty) / s)),
  ];
  if (visible[2] <= visible[0] || visible[3] <= visible[1]) {
    return;
  }
  const satisfied = (layer: { window: PixelWindow; resolution: number } | undefined) =>
    layer && layer.resolution >= needed * 0.99 && covers(layer.window, visible);
  if ((detail?.page === pageIndex && satisfied(detail)) || satisfied(pendingDetail)) {
    return;
  }
  // Render a little more than visible so that small pans do not need a new request.
  const mx = Math.round((visible[2] - visible[0]) * 0.1);
  const my = Math.round((visible[3] - visible[1]) * 0.1);
  const window: PixelWindow = [
    Math.max(0, visible[0] - mx),
    Math.max(0, visible[1] - my),
    Math.min(page.width, visible[2] + mx),
    Math.min(page.height, visible[3] + my),
  ];
  const outWidth = Math.max(1, Math.round((window[2] - window[0]) * needed));
  const outHeight = Math.max(1, Math.round((window[3] - window[1]) * needed));
  pendingDetail = { window, resolution: outWidth / (window[2] - window[0]) };
  detailReq = ++requestCounter;
  postToWorker({ type: 'render', reqId: detailReq, kind: 'detail', page: pageIndex, window, outWidth, outHeight, tone });
}

function setTone(value: ToneMode): void {
  tone = value;
  if (!currentPage() || !preview) {
    return;
  }
  // The worker keeps the decoded samples, so this only re-maps colours.
  requestPreview();
  if (detail) {
    const { window, bitmap } = detail;
    detailReq = ++requestCounter;
    pendingDetail = { window, resolution: detail.resolution };
    postToWorker({
      type: 'render',
      reqId: detailReq,
      kind: 'detail',
      page: pageIndex,
      window,
      outWidth: bitmap.width,
      outHeight: bitmap.height,
      tone,
    });
  }
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

function layout(): void {
  if (fitMode) {
    const s = fitScale();
    view.scale = fitMode === 'auto' ? Math.min(1, s) : s;
  }
  clampView();
  updateZoomLabel();
  draw();
  scheduleDetail();
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
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  const width = Math.round(cw * dpr);
  const height = Math.round(ch * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const page = currentPage();
  if (!page || !preview) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const s = view.scale;
  if (page.hasAlpha) {
    const x0 = Math.max(0, view.tx);
    const y0 = Math.max(0, view.ty);
    const x1 = Math.min(cw, view.tx + page.width * s);
    const y1 = Math.min(ch, view.ty + page.height * s);
    if (x1 > x0 && y1 > y0) {
      ctx.fillStyle = checkerPattern();
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  drawLayer(preview, cw, ch);
  if (detail && detail.page === pageIndex) {
    drawLayer(detail, cw, ch);
  }
}

function drawLayer(layer: Layer, cw: number, ch: number): void {
  const s = view.scale;
  const [wx0, wy0, wx1, wy1] = layer.window;
  const destX = view.tx + wx0 * s;
  const destY = view.ty + wy0 * s;
  const destW = (wx1 - wx0) * s;
  const destH = (wy1 - wy0) * s;
  // Clip to the viewport to keep coordinates small at high zoom.
  const dx0 = Math.max(0, destX);
  const dy0 = Math.max(0, destY);
  const dx1 = Math.min(cw, destX + destW);
  const dy1 = Math.min(ch, destY + destH);
  if (dx1 <= dx0 || dy1 <= dy0) {
    return;
  }
  const bw = layer.bitmap.width;
  const bh = layer.bitmap.height;
  const sx0 = ((dx0 - destX) / destW) * bw;
  const sy0 = ((dy0 - destY) / destH) * bh;
  const sx1 = ((dx1 - destX) / destW) * bw;
  const sy1 = ((dy1 - destY) / destH) * bh;
  const devicePxPerBitmapPx = (s / layer.resolution) * devicePixelRatio;
  // Show crisp pixels when magnifying full-resolution data; smooth otherwise.
  ctx.imageSmoothingEnabled = !(layer.resolution >= 0.999 && devicePxPerBitmapPx >= 1);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(layer.bitmap, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function showProgress(fraction: number | undefined): void {
  progress.hidden = fraction === undefined;
  progressBar.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
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
      scheduleDetail();
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
    scheduleDetail();
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
  if (!page || !preview) {
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
      scheduleDetail();
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
