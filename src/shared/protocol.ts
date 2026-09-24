/**
 * Message types exchanged between the extension host, the webview UI and the
 * decoder worker that runs inside the webview.
 *
 *   extension host  <-- postMessage -->  webview (main.ts)  <-- postMessage -->  worker.ts
 *
 * The worker never touches the file directly: it asks for byte ranges, the
 * webview relays the request to the extension host, which reads the file.
 */

export interface ByteRange {
  offset: number;
  length: number;
}

/** [x0, y0, x1, y1] in pixels, x1/y1 exclusive. */
export type PixelWindow = [number, number, number, number];

export type ToneMode = 'minmax' | 'percentile' | 'full';

// ---------------------------------------------------------------------------
// Extension host <-> webview
// ---------------------------------------------------------------------------

export type HostToWebview =
  | { type: 'init'; fileName: string; fileSize: number }
  | { type: 'readResult'; id: number; data: Uint8Array[] }
  | { type: 'readError'; id: number; message: string }
  | { type: 'reload'; fileSize: number };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'read'; id: number; ranges: ByteRange[] };

// ---------------------------------------------------------------------------
// Webview <-> worker
// ---------------------------------------------------------------------------

export interface LevelInfo {
  /** IFD index inside the file. */
  ifd: number;
  width: number;
  height: number;
}

export interface PageInfo {
  /** IFD index inside the file. */
  ifd: number;
  width: number;
  height: number;
  samplesPerPixel: number;
  bitsPerSample: number[];
  sampleFormat: string;
  photometric: string;
  compression: string;
  planar: string;
  layout: string;
  hasAlpha: boolean;
  noData: number | null;
  /** Full resolution first, then reduced-resolution overviews (largest first). */
  levels: LevelInfo[];
  /** Whether the tone (contrast stretch) selector is meaningful for this page. */
  toneAdjustable: boolean;
  /** Whether "full range" makes sense (integer data). */
  fullRangeAvailable: boolean;
  /** Label of each sample, e.g. R, G, B, A. */
  sampleLabels: string[];
  /** Human readable tag list for the info panel. */
  tags: [string, string][];
  /** Decoding problem detected up front (e.g. unsupported compression). */
  unsupported?: string;
}

export interface FileInfo {
  bigTiff: boolean;
  littleEndian: boolean;
  fileSize: number;
  ifdCount: number;
  pages: PageInfo[];
}

export type RenderKind = 'preview' | 'detail';

export type MainToWorker =
  | { type: 'open'; fileSize: number }
  | { type: 'readResult'; id: number; data: ArrayBuffer[] }
  | { type: 'readError'; id: number; message: string }
  | {
      type: 'render';
      reqId: number;
      kind: RenderKind;
      page: number;
      /** Window in full-resolution pixel coordinates. */
      window: PixelWindow;
      outWidth: number;
      outHeight: number;
      tone: ToneMode;
    }
  | { type: 'pixel'; reqId: number; page: number; x: number; y: number };

export type WorkerToMain =
  | { type: 'read'; id: number; ranges: ByteRange[] }
  | { type: 'opened'; info: FileInfo }
  | { type: 'openError'; message: string }
  | { type: 'progress'; reqId: number; kind: RenderKind; done: number; total: number }
  | {
      type: 'rendered';
      reqId: number;
      kind: RenderKind;
      page: number;
      window: PixelWindow;
      width: number;
      height: number;
      rgba: ArrayBuffer;
    }
  | { type: 'renderError'; reqId: number; kind: RenderKind; page: number; message: string }
  | { type: 'pixel'; reqId: number; x: number; y: number; values: number[] | null };
