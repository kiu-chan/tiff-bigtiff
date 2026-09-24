import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ByteRange, HostToWebview, WebviewToHost } from './shared/protocol';

/** Largest single read served to the webview (protects against corrupt byte counts). */
const MAX_READ_BYTES = 512 * 1024 * 1024;

/**
 * Random access to the bytes of a TIFF file.
 *
 * Local files are read with positional reads so that multi-gigabyte BigTIFFs
 * never have to be loaded into memory. Files on other file systems (virtual
 * workspaces, etc.) are read once through `vscode.workspace.fs`.
 */
class TiffDocument implements vscode.CustomDocument {
  private handle: fs.promises.FileHandle | undefined;
  private bytes: Uint8Array | undefined;
  private opening: Promise<void> | undefined;
  size = 0;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly uri: vscode.Uri) {
    const folder = vscode.Uri.joinPath(uri, '..');
    const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, name));
    const onChange = () => {
      clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => void this.reopen(), 300);
    };
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
  }

  open(): Promise<void> {
    this.opening ??= this.doOpen();
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    if (this.uri.scheme === 'file') {
      this.handle = await fs.promises.open(this.uri.fsPath, 'r');
      this.size = (await this.handle.stat()).size;
    } else {
      this.bytes = await vscode.workspace.fs.readFile(this.uri);
      this.size = this.bytes.byteLength;
    }
  }

  private async reopen(): Promise<void> {
    await this.close();
    try {
      await this.open();
    } catch {
      // The file may be mid-write or deleted; the viewer shows the error on its next read.
    }
    this.onDidChangeEmitter.fire();
  }

  async read(range: ByteRange): Promise<Uint8Array> {
    await this.open();
    const start = Math.max(0, Math.min(range.offset, this.size));
    const length = Math.max(0, Math.min(range.length, this.size - start, MAX_READ_BYTES));
    if (this.bytes) {
      return this.bytes.slice(start, start + length);
    }
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle!.read(out, done, length - done, start + done);
      if (bytesRead === 0) {
        break;
      }
      done += bytesRead;
    }
    return done === length ? out : out.subarray(0, done);
  }

  private async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    this.bytes = undefined;
    this.opening = undefined;
    await handle?.close().catch(() => undefined);
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
    this.watcher.dispose();
    this.onDidChangeEmitter.dispose();
    void this.close();
  }
}

export class TiffEditorProvider implements vscode.CustomReadonlyEditorProvider<TiffDocument> {
  static readonly viewType = 'tiffBigtiff.viewer';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      TiffEditorProvider.viewType,
      new TiffEditorProvider(context.extensionUri),
      {
        supportsMultipleEditorsPerDocument: true,
        // Decoding large images is expensive; keep the result when the tab is hidden.
        webviewOptions: { retainContextWhenHidden: true },
      },
    );
  }

  constructor(private readonly extensionUri: vscode.Uri) {}

  async openCustomDocument(uri: vscode.Uri): Promise<TiffDocument> {
    const document = new TiffDocument(uri);
    await document.open();
    return document;
  }

  async resolveCustomEditor(document: TiffDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    webview.html = this.getHtml(webview);

    const post = (message: HostToWebview) => webview.postMessage(message);
    const fileName = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1);

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      webview.onDidReceiveMessage(async (message: WebviewToHost) => {
        switch (message.type) {
          case 'ready':
            await document.open().catch(() => undefined);
            void post({ type: 'init', fileName, fileSize: document.size });
            break;
          case 'read':
            try {
              const data = await Promise.all(message.ranges.map((range) => document.read(range)));
              void post({ type: 'readResult', id: message.id, data });
            } catch (error) {
              void post({ type: 'readError', id: message.id, message: String((error as Error)?.message ?? error) });
            }
            break;
        }
      }),
      document.onDidChange(() => void post({ type: 'reload', fileSize: document.size })),
    );
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
  }

  private getHtml(webview: vscode.Webview): string {
    const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...path));
    const nonce = createNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      // The decoder worker is fetched from the extension and started from a blob: URL;
      // the ZSTD and LERC decoders load their WebAssembly from data: URLs.
      `connect-src ${webview.cspSource} data:`,
      `worker-src blob:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'viewer.css')}">
  <title>TIFF Viewer</title>
</head>
<body>
  <div id="toolbar" role="toolbar">
    <label class="group" id="pageGroup" hidden>
      <span>Page</span>
      <select id="page" title="Page (PageUp / PageDown)"></select>
    </label>
    <div class="group">
      <button id="zoomOut" title="Zoom out (-)" aria-label="Zoom out">&minus;</button>
      <span id="zoomLabel" class="zoom-label">&ndash;</span>
      <button id="zoomIn" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <button id="fit" title="Fit to window (0)">Fit</button>
      <button id="actual" title="Actual size (1)">1:1</button>
    </div>
    <label class="group" id="toneGroup" hidden title="How sample values are mapped to screen brightness">
      <span>Contrast</span>
      <select id="tone">
        <option value="minmax">Min – max</option>
        <option value="percentile">2% – 98%</option>
        <option value="full">Full range</option>
      </select>
    </label>
    <span class="spacer"></span>
    <button id="infoToggle" title="Image information (I)" aria-pressed="false">Info</button>
  </div>
  <div id="main">
    <div id="stage" tabindex="0">
      <canvas id="canvas"></canvas>
      <div id="progress" hidden><div id="progressBar"></div></div>
      <div id="message" hidden></div>
    </div>
    <aside id="info" hidden></aside>
  </div>
  <div id="status">
    <span id="statusSize"></span>
    <span id="statusPos"></span>
    <span id="statusValue"></span>
  </div>
  <script nonce="${nonce}">window.TIFF_WORKER_URL = ${JSON.stringify(asset('dist', 'webview', 'worker.js').toString())};</script>
  <script nonce="${nonce}" src="${asset('dist', 'webview', 'main.js')}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
