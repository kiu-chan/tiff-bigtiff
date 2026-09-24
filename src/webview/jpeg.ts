import { BaseDecoder } from 'geotiff';
// Not exported from the package entry point; imported by path so that it can be used as a fallback.
import GeotiffJpegDecoder from '../../node_modules/geotiff/dist-module/compression/jpeg.js';

/**
 * Whether JPEG tiles can be decoded with the browser's native decoder
 * (libjpeg-turbo, off the JavaScript thread, several tiles in parallel).
 * That is many times faster than geotiff.js' JavaScript decoder.
 */
export function canDecodeJpegNatively(): boolean {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';
}

/**
 * Whether tiles of an image with this photometric interpretation go through the
 * native decoder. The browser always converts three-component JPEG from YCbCr to
 * RGB, so only YCbCr (and single-component grey) data can be decoded that way;
 * "RGB" JPEG streams are left to geotiff.js, which returns the raw components.
 */
export function usesNativeJpeg(photometric: number, samplesPerPixel: number): boolean {
  return (
    canDecodeJpegNatively() &&
    ((photometric === 6 && samplesPerPixel === 3) || (photometric <= 1 && samplesPerPixel === 1))
  );
}

interface JpegParameters {
  tileWidth: number;
  tileHeight: number;
  predictor: number;
  planarConfiguration: number;
  bitsPerSample: number[];
  samplesPerPixel: number;
  photometric: number;
  JPEGTables?: Uint8Array;
}

/**
 * Whether JPEG tiles can be decoded at 1/2, 1/4 or 1/8 of their size. libjpeg
 * then skips most of the inverse DCT, which makes overviews many times faster.
 */
export function canDecodeJpegScaled(): boolean {
  return canDecodeJpegNatively() && typeof ImageDecoder === 'function';
}

let canvas: OffscreenCanvas | undefined;
let context: OffscreenCanvasRenderingContext2D | undefined;

function pixelsOf(bitmap: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  if (!canvas || canvas.width < width || canvas.height < height) {
    canvas = new OffscreenCanvas(Math.max(width, canvas?.width ?? 0), Math.max(height, canvas?.height ?? 0));
    context = canvas.getContext('2d', { willReadFrequently: true })!;
  }
  // drawImage + getImageData run without awaiting, so the shared canvas is safe
  // to reuse across concurrent decodes.
  context!.clearRect(0, 0, width, height);
  context!.drawImage(bitmap, 0, 0);
  return context!.getImageData(0, 0, width, height).data;
}

export class JpegDecoder extends BaseDecoder {
  private readonly native: boolean;
  private readonly tables: Uint8Array<ArrayBuffer> | undefined;
  private fallback: InstanceType<typeof GeotiffJpegDecoder> | undefined;

  constructor(parameters: JpegParameters) {
    super(parameters as never);
    this.native = usesNativeJpeg(parameters.photometric, parameters.samplesPerPixel);
    const tables = parameters.JPEGTables;
    // JPEGTables is a complete stream (SOI ... EOI); drop the EOI to prepend it to each tile.
    this.tables = tables && tables.length > 4 ? new Uint8Array(tables).subarray(0, tables.length - 2) : undefined;
  }

  /** Whether decodeScaled() can reduce the size while decoding. */
  get scalable(): boolean {
    return this.native && canDecodeJpegScaled();
  }

  async decodeBlock(buffer: ArrayBufferLike): Promise<ArrayBufferLike> {
    if (!this.native) {
      this.fallback ??= new GeotiffJpegDecoder(this.parameters as never);
      return this.fallback.decodeBlock(buffer as ArrayBuffer);
    }
    const bitmap = await createImageBitmap(new Blob(this.stream(buffer), { type: 'image/jpeg' }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const { width, height } = bitmap;
    const rgba = pixelsOf(bitmap, width, height);
    bitmap.close();
    const p = this.parameters as unknown as JpegParameters;
    return this.pack(rgba, width, height, p.tileWidth, Math.min(p.tileHeight, height));
  }

  /**
   * Decodes a tile at 1/`reduction` of its size (reduction 2, 4 or 8; the tile
   * width must be a multiple of it). Only valid when canDecodeJpegScaled().
   */
  async decodeScaled(buffer: ArrayBufferLike, reduction: number): Promise<ArrayBufferLike> {
    if (!this.native || reduction === 1) {
      return this.decode(buffer as ArrayBuffer);
    }
    const data = await new Blob(this.stream(buffer)).arrayBuffer();
    const p = this.parameters as unknown as JpegParameters;
    // Asking for an exact 1/2, 1/4 or 1/8 size lets libjpeg scale while decoding.
    const decoder = new ImageDecoder({
      data,
      type: 'image/jpeg',
      desiredWidth: p.tileWidth / reduction,
      desiredHeight: Math.ceil(p.tileHeight / reduction),
      colorSpaceConversion: 'none',
    });
    const outWidth = p.tileWidth / reduction;
    const outHeight = Math.ceil(p.tileHeight / reduction);
    let frame: VideoFrame | ImageBitmap;
    try {
      frame = (await decoder.decode()).image;
    } finally {
      decoder.close();
    }
    if (frame.displayWidth !== outWidth) {
      // The decoder picked another scale; resize to the expected size instead.
      frame.close();
      frame = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }), {
        resizeWidth: outWidth,
        resizeHeight: outHeight,
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
    }
    const width = frame instanceof ImageBitmap ? frame.width : frame.displayWidth;
    const height = frame instanceof ImageBitmap ? frame.height : frame.displayHeight;
    const rgba = pixelsOf(frame, width, height);
    frame.close();
    return this.pack(rgba, width, height, outWidth, Math.min(outHeight, height));
  }

  /** Tiles are abbreviated streams (SOI, frame and scan data); prepend the shared tables. */
  private stream(buffer: ArrayBufferLike): BlobPart[] {
    const tile = new Uint8Array(buffer as ArrayBuffer);
    return this.tables ? [this.tables, tile.subarray(2)] : [tile];
  }

  /** Copies the colour channels of RGBA pixels into an outWidth × outHeight × spp buffer. */
  private pack(rgba: Uint8ClampedArray, width: number, height: number, outWidth: number, outHeight: number): ArrayBuffer {
    const spp = (this.parameters as unknown as JpegParameters).samplesPerPixel;
    const out = new Uint8Array(outWidth * outHeight * spp);
    const copyWidth = Math.min(width, outWidth);
    for (let y = 0; y < outHeight; y++) {
      let s = y * width * 4;
      let d = y * outWidth * spp;
      if (spp === 3) {
        for (let x = 0; x < copyWidth; x++, s += 4, d += 3) {
          out[d] = rgba[s];
          out[d + 1] = rgba[s + 1];
          out[d + 2] = rgba[s + 2];
        }
      } else {
        for (let x = 0; x < copyWidth; x++, s += 4, d++) {
          out[d] = rgba[s];
        }
      }
    }
    return out.buffer;
  }
}
