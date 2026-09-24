import { addDecoder, BaseDecoder, GeoTIFF, getDecoder, type GeoTIFFImage } from 'geotiff';
// Not exported from the package entry point.
import { getDecoderParameters } from '../../node_modules/geotiff/dist-module/compression/index.js';
import type { FileInfo, LevelInfo, PageInfo, PixelWindow, ToneMode } from '../shared/protocol';
import { decodeCcitt } from './ccitt';
import { JpegDecoder, usesNativeJpeg } from './jpeg';
import type { MessageSource } from './messageSource';

type Sample = ArrayLike<number> & { [index: number]: number };

const enum Tag {
  NewSubfileType = 254,
  ImageWidth = 256,
  ImageLength = 257,
  BitsPerSample = 258,
  Compression = 259,
  Photometric = 262,
  FillOrder = 266,
  DocumentName = 269,
  ImageDescription = 270,
  Make = 271,
  Model = 272,
  SamplesPerPixel = 277,
  RowsPerStrip = 278,
  XResolution = 282,
  YResolution = 283,
  PlanarConfiguration = 284,
  PageName = 285,
  T4Options = 292,
  JPEGTables = 347,
  ResolutionUnit = 296,
  Software = 305,
  DateTime = 306,
  Artist = 315,
  HostComputer = 316,
  Predictor = 317,
  ColorMap = 320,
  TileWidth = 322,
  TileLength = 323,
  ExtraSamples = 338,
  SampleFormat = 339,
  Copyright = 33432,
  ModelPixelScale = 33550,
  ModelTiepoint = 33922,
  ModelTransformation = 34264,
  GeoKeyDirectory = 34735,
}

const COMPRESSION_NAMES: Record<number, string> = {
  1: 'None',
  2: 'CCITT modified Huffman RLE',
  3: 'CCITT Group 3 fax',
  4: 'CCITT Group 4 fax',
  5: 'LZW',
  6: 'Old-style JPEG',
  7: 'JPEG',
  8: 'Deflate',
  32946: 'Deflate (legacy)',
  32773: 'PackBits',
  33003: 'JPEG 2000 (Aperio)',
  33005: 'JPEG 2000 (Aperio)',
  34712: 'JPEG 2000',
  34887: 'LERC',
  34925: 'LZMA',
  50000: 'Zstandard',
  50001: 'WebP',
  50002: 'JPEG XL',
};
const SUPPORTED_COMPRESSIONS = new Set([1, 2, 3, 4, 5, 7, 8, 32946, 32773, 34887, 50000, 50001]);

const PHOTOMETRIC_NAMES: Record<number, string> = {
  0: 'WhiteIsZero',
  1: 'BlackIsZero',
  2: 'RGB',
  3: 'Palette',
  4: 'Transparency mask',
  5: 'Separated (CMYK)',
  6: 'YCbCr',
  8: 'CIE L*a*b*',
  9: 'ICC L*a*b*',
  10: 'ITU L*a*b*',
  32844: 'LogL',
  32845: 'LogLuv',
  34892: 'Linear raw',
};

const SAMPLE_FORMAT_NAMES: Record<number, string> = {
  1: 'Unsigned integer',
  2: 'Signed integer',
  3: 'Floating point',
  4: 'Undefined',
};

/** Longer text tags (e.g. embedded XML metadata) are cut in the info panel. */
const MAX_TAG_TEXT = 1500;

let decodersRegistered = false;

/**
 * Adds CCITT fax support (compression 2, 3, 4), which geotiff.js does not ship,
 * and replaces its JPEG decoder with one that uses the browser's native decoder.
 */
export function registerDecoders(): void {
  if (decodersRegistered) {
    return;
  }
  decodersRegistered = true;

  class CcittDecoder extends BaseDecoder {
    decodeBlock(buffer: ArrayBufferLike): ArrayBufferLike {
      const p = this.parameters as unknown as {
        compression: 2 | 3 | 4;
        tileWidth: number;
        tileHeight: number;
        t4Options: number;
        fillOrder: number;
      };
      return decodeCcitt(new Uint8Array(buffer), {
        compression: p.compression,
        width: p.tileWidth,
        height: p.tileHeight,
        t4Options: p.t4Options,
        fillOrder: p.fillOrder,
      }).buffer;
    }
  }

  for (const compression of [2, 3, 4] as const) {
    addDecoder(
      compression,
      async () => CcittDecoder,
      async (fd) => {
        const value = async (id: number) => (fd.hasTag(id) ? fd.loadValue(id) : undefined);
        const imageWidth = Number(await value(Tag.ImageWidth));
        const imageLength = Number(await value(Tag.ImageLength));
        const tiled = fd.hasTag(Tag.TileWidth);
        const rows = tiled
          ? Number(await value(Tag.TileLength))
          : Math.min(Number((await value(Tag.RowsPerStrip)) ?? imageLength), imageLength);
        return {
          tileWidth: tiled ? Number(await value(Tag.TileWidth)) : imageWidth,
          tileHeight: rows,
          planarConfiguration: 1,
          bitsPerSample: [1],
          predictor: 1,
          compression,
          t4Options: Number((await value(Tag.T4Options)) ?? 0),
          fillOrder: Number((await value(Tag.FillOrder)) ?? 1),
        } as never;
      },
      false,
    );
  }

  addDecoder(
    7,
    async () => JpegDecoder as never,
    async (fd) => {
      const value = async (id: number) => (fd.hasTag(id) ? fd.loadValue(id) : undefined);
      const tiled = fd.hasTag(Tag.TileWidth);
      const imageLength = Number(await value(Tag.ImageLength));
      return {
        tileWidth: Number(await value(tiled ? Tag.TileWidth : Tag.ImageWidth)),
        tileHeight: tiled
          ? Number(await value(Tag.TileLength))
          : Math.min(Number((await value(Tag.RowsPerStrip)) ?? imageLength), imageLength),
        planarConfiguration: Number((await value(Tag.PlanarConfiguration)) ?? 1),
        bitsPerSample: toArray(await value(Tag.BitsPerSample)),
        predictor: 1,
        samplesPerPixel: Number((await value(Tag.SamplesPerPixel)) ?? 1),
        photometric: Number((await value(Tag.Photometric)) ?? 2),
        JPEGTables: await value(Tag.JPEGTables),
      } as never;
    },
    false,
  );
}

type ColorKind = 'gray' | 'rgb' | 'palette' | 'cmyk' | 'ycbcr' | 'lab';

interface Stats {
  min: number;
  max: number;
  p02: number;
  p98: number;
}

/** Everything the worker needs to decode and colourise one page (not sent to the UI). */
export interface Page {
  info: PageInfo;
  images: GeoTIFFImage[];
  kind: ColorKind;
  whiteIsZero: boolean;
  /** Sample indices read for display, in order (colour samples, then alpha if any). */
  samples: number[];
  alphaAssociated: boolean;
  bits: number;
  format: number;
  colorMap?: ArrayLike<number>;
  stats?: Stats;
}

export interface OpenedTiff {
  tiff: GeoTIFF;
  info: FileInfo;
  pages: Page[];
}

async function tagValue(image: GeoTIFFImage, id: number): Promise<unknown> {
  const fd = image.getFileDirectory();
  if (!fd.hasTag(id)) {
    return undefined;
  }
  try {
    return await fd.loadValue(id);
  } catch {
    return undefined;
  }
}

function toArray(value: unknown): number[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return [Number(value)];
  }
  return Array.from(value as ArrayLike<number>, Number);
}

function formatRational(value: unknown): string {
  const parts = toArray(value);
  if (parts.length >= 2 && parts[1]) {
    return String(Math.round((parts[0] / parts[1]) * 1000) / 1000);
  }
  return parts.length ? String(parts[0]) : '';
}

export async function openTiff(source: MessageSource): Promise<OpenedTiff> {
  registerDecoders();
  const tiff = await GeoTIFF.fromSource(source as never);
  const ifdCount = await tiff.getImageCount();

  const pages: Page[] = [];
  const masks: Page[] = [];
  for (let ifd = 0; ifd < ifdCount; ifd++) {
    const image = await tiff.getImage(ifd);
    const subfileType = Number((await tagValue(image, Tag.NewSubfileType)) ?? 0);
    const last = pages[pages.length - 1];
    const isReduced = (subfileType & 1) !== 0;
    if (
      isReduced &&
      last &&
      image.getWidth() < last.info.width &&
      image.getSamplesPerPixel() === last.images[0].getSamplesPerPixel()
    ) {
      last.images.push(image);
      continue;
    }
    const page = await describePage(image, ifd);
    if ((subfileType & 4) !== 0 && !isReduced) {
      masks.push(page);
    } else {
      pages.push(page);
    }
  }
  if (pages.length === 0) {
    pages.push(...masks);
  }

  for (const page of pages) {
    page.images.sort((a, b) => b.getWidth() - a.getWidth());
    page.info.levels = page.images.map(
      (image): LevelInfo => ({
        ifd: -1,
        width: image.getWidth(),
        height: image.getHeight(),
        tileWidth: image.getTileWidth(),
        tileHeight: image.getTileHeight(),
      }),
    );
    page.info.levels[0].ifd = page.info.ifd;
  }

  const t = tiff as unknown as { bigTiff: boolean; littleEndian: boolean };
  return {
    tiff,
    pages,
    info: {
      bigTiff: t.bigTiff,
      littleEndian: t.littleEndian,
      fileSize: source.fileSize,
      ifdCount,
      pages: pages.map((p) => p.info),
    },
  };
}

async function describePage(image: GeoTIFFImage, ifd: number): Promise<Page> {
  const spp = image.getSamplesPerPixel();
  const bitsPerSample = toArray(await tagValue(image, Tag.BitsPerSample));
  if (bitsPerSample.length === 0) {
    // BitsPerSample defaults to 1 (bilevel) when absent; geotiff.js requires the tag.
    bitsPerSample.push(...new Array<number>(spp).fill(1));
    (image.getFileDirectory().actualizedFields as Map<number, unknown>).set(Tag.BitsPerSample, Uint16Array.from(bitsPerSample));
  }
  const bits = bitsPerSample[0];
  const format = toArray(await tagValue(image, Tag.SampleFormat))[0] ?? 1;
  const photometric = Number((await tagValue(image, Tag.Photometric)) ?? (spp >= 3 ? 2 : 1));
  const compression = Number((await tagValue(image, Tag.Compression)) ?? 1);
  const planar = Number((await tagValue(image, Tag.PlanarConfiguration)) ?? 1);
  const extraSamples = toArray(await tagValue(image, Tag.ExtraSamples));
  const tiled = image.getFileDirectory().hasTag(Tag.TileWidth);

  let kind: ColorKind;
  let colorSamples: number[];
  let colorMap: ArrayLike<number> | undefined;
  let labels: string[];
  switch (photometric) {
    case 2:
      kind = spp >= 3 ? 'rgb' : 'gray';
      break;
    case 3:
      colorMap = (await tagValue(image, Tag.ColorMap)) as ArrayLike<number> | undefined;
      kind = colorMap ? 'palette' : 'gray';
      break;
    case 5:
      kind = spp >= 4 ? 'cmyk' : 'gray';
      break;
    case 6:
      // The native JPEG decoder already converts YCbCr to RGB.
      kind = spp >= 3 ? (compression === 7 && usesNativeJpeg(6, spp) ? 'rgb' : 'ycbcr') : 'gray';
      break;
    case 8:
      kind = spp >= 3 ? 'lab' : 'gray';
      break;
    case 0:
    case 1:
    case 4:
      kind = 'gray';
      break;
    default:
      kind = spp >= 3 ? 'rgb' : 'gray';
  }
  switch (kind) {
    case 'rgb':
      colorSamples = [0, 1, 2];
      labels = ['R', 'G', 'B'];
      break;
    case 'cmyk':
      colorSamples = [0, 1, 2, 3];
      labels = ['C', 'M', 'Y', 'K'];
      break;
    case 'ycbcr':
      colorSamples = [0, 1, 2];
      labels = ['Y', 'Cb', 'Cr'];
      break;
    case 'lab':
      colorSamples = [0, 1, 2];
      labels = ['L*', 'a*', 'b*'];
      break;
    case 'palette':
      colorSamples = [0];
      labels = ['Index'];
      break;
    default:
      colorSamples = [0];
      labels = ['Value'];
  }
  const alphaType = extraSamples[0];
  const alphaIndex = colorSamples.length;
  const hasAlpha = (alphaType === 1 || alphaType === 2) && spp > alphaIndex;
  const samples = hasAlpha ? [...colorSamples, alphaIndex] : colorSamples;
  for (let i = labels.length; i < spp; i++) {
    labels.push(i === alphaIndex && hasAlpha ? 'A' : `S${i}`);
  }

  const noData = image.getGDALNoData();
  const toneAdjustable = (kind === 'gray' || kind === 'rgb') && !(format === 1 && bits <= 8);

  const tags: [string, string][] = [];
  const addText = async (label: string, id: number) => {
    const value = await tagValue(image, id);
    if (typeof value === 'string' && value.trim()) {
      const text = value.replace(/\0+$/, '').trim();
      tags.push([label, text.length > MAX_TAG_TEXT ? `${text.slice(0, MAX_TAG_TEXT)}… (${text.length} characters)` : text]);
    }
  };
  await addText('Document name', Tag.DocumentName);
  await addText('Page name', Tag.PageName);
  await addText('Description', Tag.ImageDescription);
  await addText('Make', Tag.Make);
  await addText('Model', Tag.Model);
  await addText('Software', Tag.Software);
  await addText('Date/time', Tag.DateTime);
  await addText('Artist', Tag.Artist);
  await addText('Host computer', Tag.HostComputer);
  await addText('Copyright', Tag.Copyright);
  const xRes = await tagValue(image, Tag.XResolution);
  if (xRes !== undefined) {
    const yRes = await tagValue(image, Tag.YResolution);
    const unit = Number((await tagValue(image, Tag.ResolutionUnit)) ?? 2);
    const unitName = unit === 2 ? ' dpi' : unit === 3 ? ' px/cm' : '';
    tags.push(['Resolution', `${formatRational(xRes)} × ${formatRational(yRes ?? xRes)}${unitName}`]);
  }
  const predictor = Number((await tagValue(image, Tag.Predictor)) ?? 1);
  if (predictor !== 1) {
    tags.push(['Predictor', predictor === 2 ? 'Horizontal differencing' : predictor === 3 ? 'Floating point' : String(predictor)]);
  }
  const fd = image.getFileDirectory();
  if (
    fd.hasTag(Tag.GeoKeyDirectory) ||
    fd.hasTag(Tag.ModelTiepoint) ||
    fd.hasTag(Tag.ModelPixelScale) ||
    fd.hasTag(Tag.ModelTransformation)
  ) {
    let geo = 'Yes';
    try {
      const keys = image.getGeoKeys() as Record<string, unknown> | null;
      const epsg = keys?.ProjectedCSTypeGeoKey ?? keys?.GeographicTypeGeoKey;
      if (typeof epsg === 'number' && epsg > 0 && epsg < 32767) {
        geo = `EPSG:${epsg}`;
      }
    } catch {
      // Malformed GeoKeyDirectory; keep "Yes".
    }
    tags.push(['GeoTIFF', geo]);
  }

  const compressionName = COMPRESSION_NAMES[compression] ?? `Unknown (${compression})`;
  const info: PageInfo = {
    ifd,
    width: image.getWidth(),
    height: image.getHeight(),
    samplesPerPixel: spp,
    bitsPerSample,
    sampleFormat: SAMPLE_FORMAT_NAMES[format] ?? String(format),
    photometric: PHOTOMETRIC_NAMES[photometric] ?? `Unknown (${photometric})`,
    compression: compressionName,
    planar: planar === 2 ? 'Separate planes' : 'Contiguous (chunky)',
    layout: tiled
      ? `Tiles ${image.getTileWidth()} × ${image.getTileHeight()}`
      : `Strips of ${image.getTileHeight()} row${image.getTileHeight() === 1 ? '' : 's'}`,
    hasAlpha: hasAlpha || noData !== null || format === 3,
    noData,
    levels: [],
    toneAdjustable,
    fullRangeAvailable: toneAdjustable && format !== 3,
    sampleLabels: labels,
    tags,
  };
  if (!SUPPORTED_COMPRESSIONS.has(compression)) {
    info.unsupported = `${compressionName} compression is not supported.`;
  } else if (format === 3 && ![16, 32, 64].includes(bits)) {
    info.unsupported = `${bits}-bit floating point samples are not supported.`;
  } else if (photometric === 6 && compression !== 7 && fd.hasTag(530)) {
    const subsampling = toArray(await tagValue(image, 530));
    if (subsampling.some((v) => v !== 1)) {
      info.unsupported = 'Uncompressed chroma-subsampled YCbCr is not supported.';
    }
  }

  return {
    info,
    images: [image],
    kind,
    whiteIsZero: photometric === 0,
    samples,
    alphaAssociated: hasAlpha && alphaType === 1,
    bits,
    format,
    colorMap,
  };
}

// ---------------------------------------------------------------------------
// Region reading
// ---------------------------------------------------------------------------

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

/** Upper bound for the decoded tiles held at once by one region read, in bytes. */
const BATCH_BYTES = 64 * 1024 * 1024;
/** Tiles decoded concurrently by one region read. */
const MAX_BATCH_TILES = 16;
/** Above this many source pixels we sample (nearest) instead of averaging. */
const AVERAGE_LIMIT = 96 * 1024 * 1024;
/** Recently decoded tiles are kept, since neighbouring display tiles often share them. */
const TILE_CACHE_BYTES = 192 * 1024 * 1024;

export interface RegionResult {
  data: Sample[];
  width: number;
  height: number;
}

export interface RegionOptions {
  isCancelled?: () => boolean;
  /** Awaited before each batch of tiles; lets a paused read wait. */
  waitTurn?: () => Promise<void> | undefined;
  /** Urgency of this read's tile decodes (lower first) when many reads compete. */
  priority?: () => number;
  onProgress?: (done: number, total: number) => void;
  /** Called whenever more output rows are final; `snapshot()` returns rows [0, rows). */
  onRows?: (rows: number, snapshot: () => Sample[]) => void;
}

/**
 * Picks the smallest pyramid level that still has at least the requested
 * resolution and maps the full-resolution window into it.
 */
export function chooseLevel(page: Page, window: PixelWindow, outWidth: number): { image: GeoTIFFImage; window: PixelWindow } {
  const full = page.images[0];
  const scale = outWidth / (window[2] - window[0]);
  let image = full;
  for (const candidate of page.images) {
    if (candidate.getWidth() / full.getWidth() >= scale * 0.98) {
      image = candidate;
    }
  }
  if (image === full) {
    return { image, window };
  }
  const fx = image.getWidth() / full.getWidth();
  const fy = image.getHeight() / full.getHeight();
  const x0 = Math.min(image.getWidth() - 1, Math.floor(window[0] * fx));
  const y0 = Math.min(image.getHeight() - 1, Math.floor(window[1] * fy));
  const x1 = Math.max(x0 + 1, Math.min(image.getWidth(), Math.ceil(window[2] * fx)));
  const y1 = Math.max(y0 + 1, Math.min(image.getHeight(), Math.ceil(window[3] * fy)));
  return { image, window: [x0, y0, x1, y1] };
}

/** Contiguous runs of tile indices [start, end) that contain at least one of the coordinates. */
function tileSpans(coords: Int32Array | null, start: number, end: number, tileSize: number): [number, number][] {
  if (!coords) {
    return [[Math.floor(start / tileSize), Math.ceil(end / tileSize)]];
  }
  const spans: [number, number][] = [];
  for (let i = 0; i < coords.length; i++) {
    const tile = Math.floor(coords[i] / tileSize);
    const last = spans[spans.length - 1];
    if (last && tile < last[1]) {
      continue;
    }
    if (last && tile === last[1]) {
      last[1]++;
    } else {
      spans.push([tile, tile + 1]);
    }
  }
  return spans;
}

function lowerBound(values: Int32Array, target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Random access to one sample of a decoded tile: value = array[pixel * stride + offset]. */
interface Plane {
  array: ArrayLike<number>;
  stride: number;
  offset: number;
}

const TYPED_ARRAYS: Record<number, Record<number, new (buffer: ArrayBufferLike, offset: number, length: number) => Sample>> = {
  1: { 1: Uint8Array, 2: Uint16Array, 4: Uint32Array },
  2: { 1: Int8Array, 2: Int16Array, 4: Int32Array },
  3: { 4: Float32Array, 8: Float64Array },
};

function samplePlane(image: GeoTIFFImage, buffer: ArrayBufferLike, sample: number, pixels: number): Plane {
  const bytes = image.getSampleByteSize(sample);
  const planar = image.planarConfiguration;
  const bytesPerPixel = planar === 1 ? image.getBytesPerPixel() : bytes;
  let byteOffset = 0;
  if (planar === 1) {
    for (let i = 0; i < sample; i++) byteOffset += image.getSampleByteSize(i);
  }
  const format = image.getSampleFormat(sample);
  const bits = image.getBitsPerSample(sample);
  const Ctor = TYPED_ARRAYS[format]?.[bytes];
  if (
    Ctor &&
    !(format === 3 && bits === 16) &&
    (bytes === 1 || image.littleEndian) &&
    bytesPerPixel % bytes === 0 &&
    byteOffset % bytes === 0
  ) {
    return {
      array: new Ctor(buffer, 0, Math.floor(buffer.byteLength / bytes)),
      stride: bytesPerPixel / bytes,
      offset: byteOffset / bytes,
    };
  }
  // Big-endian multi-byte or float16 data: convert through a DataView.
  const view = new DataView(buffer as ArrayBuffer);
  const reader = image.getReaderForSample(sample);
  const count = Math.min(pixels, Math.floor((buffer.byteLength - byteOffset) / bytesPerPixel) + 1);
  const array = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    array[i] = reader.call(view, i * bytesPerPixel + byteOffset, image.littleEndian);
  }
  return { array, stride: 1, offset: 0 };
}

// ---------------------------------------------------------------------------
// Tile access
// ---------------------------------------------------------------------------

/** Tile reads and decodes in flight at once, across all region reads. */
const MAX_TILE_READS = 96;
let tileReads = 0;
const tileReadWaiters: { priority: () => number; start: () => void }[] = [];

/** Waits for a free tile read slot; the most urgent waiter gets the next one. */
function acquireTileRead(priority: () => number): Promise<void> {
  if (tileReads < MAX_TILE_READS) {
    tileReads++;
    return Promise.resolve();
  }
  return new Promise((start) => tileReadWaiters.push({ priority, start }));
}

function releaseTileRead(): void {
  if (tileReadWaiters.length === 0) {
    tileReads--;
    return;
  }
  let best = 0;
  let bestPriority = tileReadWaiters[0].priority();
  for (let i = 1; i < tileReadWaiters.length; i++) {
    const priority = tileReadWaiters[i].priority();
    if (priority < bestPriority) {
      best = i;
      bestPriority = priority;
    }
  }
  tileReadWaiters.splice(best, 1)[0].start();
}

const imageIds = new WeakMap<GeoTIFFImage, number>();
let nextImageId = 1;
const decoders = new WeakMap<GeoTIFFImage, Promise<BaseDecoder>>();
const tileCache = new Map<string, ArrayBufferLike>();
const tilesDecoding = new Map<string, Promise<ArrayBufferLike>>();
let tileCacheBytes = 0;

function decoderFor(image: GeoTIFFImage): Promise<BaseDecoder> {
  let decoder = decoders.get(image);
  if (!decoder) {
    decoder = (async () => {
      const compression = Number((await tagValue(image, Tag.Compression)) ?? 1);
      return (await getDecoder(compression, await getDecoderParameters(compression, image.getFileDirectory()))) as BaseDecoder;
    })();
    decoders.set(image, decoder);
  }
  return decoder;
}

/**
 * Decodes one tile or strip (one sample plane when planar), optionally at
 * 1/`reduction` of its size. Recently decoded tiles come from a cache.
 */
async function readTile(
  image: GeoTIFFImage,
  tx: number,
  ty: number,
  sample: number,
  reduction: number,
  priority: () => number = () => 0,
): Promise<ArrayBufferLike> {
  let id = imageIds.get(image);
  if (id === undefined) {
    id = nextImageId++;
    imageIds.set(image, id);
  }
  const key = `${id}/${tx}/${ty}/${sample}/${reduction}`;
  const cached = tileCache.get(key);
  if (cached) {
    tileCache.delete(key);
    tileCache.set(key, cached);
    return cached;
  }
  let pending = tilesDecoding.get(key);
  if (!pending) {
    pending = (async () => {
      await acquireTileRead(priority);
      try {
        const decoder = await decoderFor(image);
        if (reduction === 1) {
          return (await image.getTileOrStrip(tx, ty, sample, decoder)).data;
        }
        return (decoder as JpegDecoder).decodeScaled(await readTileBytes(image, tx, ty, sample), reduction);
      } finally {
        releaseTileRead();
      }
    })();
    tilesDecoding.set(key, pending);
  }
  try {
    const data = await pending;
    if (!tileCache.has(key)) {
      tileCache.set(key, data);
      tileCacheBytes += data.byteLength;
      for (const [oldKey, oldData] of tileCache) {
        if (tileCacheBytes <= TILE_CACHE_BYTES) break;
        tileCache.delete(oldKey);
        tileCacheBytes -= oldData.byteLength;
      }
    }
    return data;
  } finally {
    tilesDecoding.delete(key);
  }
}

/** The compressed bytes of a tile (what geotiff.js' getTileOrStrip reads before decoding). */
async function readTileBytes(image: GeoTIFFImage, tx: number, ty: number, sample: number): Promise<ArrayBuffer> {
  const perRow = Math.ceil(image.getWidth() / image.getTileWidth());
  const perColumn = Math.ceil(image.getHeight() / image.getTileHeight());
  const index = (image.planarConfiguration === 2 ? sample * perRow * perColumn : 0) + ty * perRow + tx;
  const fd = image.getFileDirectory() as unknown as { loadValueIndexed(name: string, index: number): Promise<number | bigint> };
  const offsets = image.isTiled ? 'TileOffsets' : 'StripOffsets';
  const counts = image.isTiled ? 'TileByteCounts' : 'StripByteCounts';
  const [offset, length] = (await Promise.all([fd.loadValueIndexed(offsets, index), fd.loadValueIndexed(counts, index)])).map(Number);
  const source = (image as unknown as { source: { fetch(ranges: { offset: number; length: number }[]): Promise<ArrayBuffer[]> } }).source;
  return (await source.fetch([{ offset, length }]))[0];
}

/**
 * How much smaller than full size tiles of `image` can be decoded when each
 * output pixel spans `step` source pixels: 1, 2, 4 or 8.
 */
async function tileReduction(image: GeoTIFFImage, step: number): Promise<number> {
  const decoder = await decoderFor(image);
  if (!(decoder instanceof JpegDecoder && decoder.scalable && image.isTiled)) {
    return 1;
  }
  const tw = image.getTileWidth();
  const th = image.getTileHeight();
  let reduction = 1;
  while (reduction < 8 && reduction * 2 <= step && tw % (reduction * 2) === 0 && th % (reduction * 2) === 0) {
    reduction *= 2;
  }
  return reduction;
}

// ---------------------------------------------------------------------------

/**
 * Reads `window` of `image` resampled to outWidth × outHeight.
 *
 * Tiles (or strips) are decoded in bounded batches, so memory use stays small
 * for huge images, and values are taken straight from the decoded tiles.
 * Downsampling averages pixels (box filter) when affordable; otherwise it picks
 * the nearest pixel and skips tiles that contain no sample point. JPEG tiles
 * are decoded at reduced size when that still gives enough resolution.
 */
export async function readRegion(
  page: Page,
  image: GeoTIFFImage,
  window: PixelWindow,
  outWidth: number,
  outHeight: number,
  options: RegionOptions = {},
): Promise<RegionResult> {
  const [x0, y0, x1, y1] = window;
  const ww = x1 - x0;
  const wh = y1 - y0;
  const ow = outWidth;
  const oh = outHeight;
  const n = ow * oh;
  const samples = page.samples;
  const exact = ow === ww && oh === wh;
  const average = !exact && page.kind !== 'palette' && ww * wh <= AVERAGE_LIMIT;
  const noData = page.info.noData;

  let srcX: Int32Array | null = null;
  let srcY: Int32Array | null = null;
  let dstX: Int32Array | null = null;
  let dstY: Int32Array | null = null;
  if (average) {
    dstX = new Int32Array(ww);
    dstY = new Int32Array(wh);
    for (let i = 0; i < ww; i++) dstX[i] = Math.min(ow - 1, Math.floor((i * ow) / ww));
    for (let i = 0; i < wh; i++) dstY[i] = Math.min(oh - 1, Math.floor((i * oh) / wh));
  } else {
    srcX = new Int32Array(ow);
    srcY = new Int32Array(oh);
    for (let i = 0; i < ow; i++) srcX[i] = Math.min(x1 - 1, x0 + Math.floor(((i + 0.5) * ww) / ow));
    for (let i = 0; i < oh; i++) srcY[i] = Math.min(y1 - 1, y0 + Math.floor(((i + 0.5) * wh) / oh));
  }

  const tw = image.getTileWidth();
  const th = image.getTileHeight();
  const colSpans = tileSpans(average || exact ? null : srcX, x0, x1, tw);
  const rowSpans = tileSpans(average || exact ? null : srcY, y0, y1, th);
  const tileCols = colSpans.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i));
  const tileRows = rowSpans.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i));
  const total = tileCols.length * tileRows.length;

  const reduction = exact ? 1 : await tileReduction(image, Math.min(ww / ow, wh / oh));
  const shift = Math.log2(reduction);
  const half = reduction >> 1;
  const rtw = tw / reduction;
  const planar = image.planarConfiguration;
  const tileBytes = (tw * th * image.getBytesPerPixel()) / (reduction * reduction);
  const batchSize = Math.max(1, Math.min(MAX_BATCH_TILES * reduction, Math.floor(BATCH_BYTES / tileBytes)));

  const nearestType = (s: number): new (length: number) => Sample => {
    const format = image.getSampleFormat(samples[s]);
    const bytes = image.getSampleByteSize(samples[s]);
    return format === 1 && bytes === 1 ? Uint8Array : format === 1 && bytes === 2 ? Uint16Array : Float32Array;
  };
  const out: Sample[] = samples.map((_, s) => (average ? new Float32Array(n) : new (nearestType(s))(n)));
  const counts = average ? new Uint32Array(n) : null;

  const processTile = (tx: number, ty: number, buffers: ArrayBufferLike[]) => {
    const tileX = tx * tw;
    const tileY = ty * th;
    const blockHeight = image.getBlockHeight(ty);
    const cx0 = Math.max(x0, tileX);
    const cx1 = Math.min(x1, tileX + tw);
    const cy0 = Math.max(y0, tileY);
    const cy1 = Math.min(y1, tileY + blockHeight);
    if (cx1 <= cx0 || cy1 <= cy0) return;
    const pixels = rtw * Math.ceil(blockHeight / reduction);
    const planes = samples.map((sample, s) => samplePlane(image, planar === 1 ? buffers[0] : buffers[s], sample, pixels));

    if (average) {
      // Each (possibly reduced) tile pixel goes to the output pixel of its centre.
      const first = planes[0];
      const rx0 = (cx0 - tileX) >> shift;
      const rx1 = (cx1 - tileX + reduction - 1) >> shift;
      const ry0 = (cy0 - tileY) >> shift;
      const ry1 = (cy1 - tileY + reduction - 1) >> shift;
      for (let ry = ry0; ry < ry1; ry++) {
        const sy = Math.min(cy1 - 1, Math.max(cy0, tileY + (ry << shift) + half));
        const oyBase = dstY![sy - y0] * ow;
        const rowBase = ry * rtw;
        for (let rx = rx0; rx < rx1; rx++) {
          const p = rowBase + rx;
          const v = first.array[p * first.stride + first.offset];
          if (v !== v || v === noData) continue;
          const sx = Math.min(cx1 - 1, Math.max(cx0, tileX + (rx << shift) + half));
          const o = oyBase + dstX![sx - x0];
          counts![o]++;
          out[0][o] += v;
          for (let s = 1; s < planes.length; s++) {
            const plane = planes[s];
            out[s][o] += plane.array[p * plane.stride + plane.offset];
          }
        }
      }
    } else {
      const ox0 = lowerBound(srcX!, cx0);
      const ox1 = lowerBound(srcX!, cx1);
      const oy0 = lowerBound(srcY!, cy0);
      const oy1 = lowerBound(srcY!, cy1);
      for (let s = 0; s < planes.length; s++) {
        const { array, stride, offset } = planes[s];
        const dst = out[s];
        for (let oy = oy0; oy < oy1; oy++) {
          const rowBase = ((srcY![oy] - tileY) >> shift) * rtw;
          const dstBase = oy * ow;
          for (let ox = ox0; ox < ox1; ox++) {
            dst[dstBase + ox] = array[(rowBase + ((srcX![ox] - tileX) >> shift)) * stride + offset];
          }
        }
      }
    }
  };

  const finish = (rows: number): Sample[] => {
    if (!average) {
      return out.map((a) => (a as Float32Array).subarray(0, rows * ow));
    }
    return out.map((acc) => {
      const result = new Float32Array(rows * ow);
      for (let i = 0; i < result.length; i++) {
        const c = counts![i];
        result[i] = c ? acc[i] / c : NaN;
      }
      return result;
    });
  };

  let done = 0;
  for (const ty of tileRows) {
    for (let i = 0; i < tileCols.length; i += batchSize) {
      await options.waitTurn?.();
      if (options.isCancelled?.()) {
        throw new CancelledError();
      }
      await Promise.all(
        tileCols.slice(i, i + batchSize).map(async (tx) => {
          const buffers =
            planar === 1
              ? [await readTile(image, tx, ty, 0, reduction, options.priority)]
              : await Promise.all(samples.map((sample) => readTile(image, tx, ty, sample, reduction, options.priority)));
          processTile(tx, ty, buffers);
          options.onProgress?.(++done, total);
        }),
      );
    }
    if (options.onRows) {
      const bottom = Math.min(y1, ty * th + image.getBlockHeight(ty));
      const rows = average ? (bottom >= y1 ? oh : dstY![bottom - y0]) : lowerBound(srcY!, bottom);
      options.onRows(rows, () => finish(rows));
    }
  }

  return { data: average ? finish(oh) : out, width: ow, height: oh };
}

export async function readPixel(page: Page, x: number, y: number): Promise<number[]> {
  const image = page.images[0];
  const rasters = (await image.readRasters({ window: [x, y, x + 1, y + 1], interleave: false })) as unknown as Sample[];
  return rasters.map((r) => Number(r[0]));
}

// ---------------------------------------------------------------------------
// Colour conversion
// ---------------------------------------------------------------------------

/** Statistics of the display samples, used for contrast stretching. */
export type { Stats };

export function computeStats(page: Page, data: Sample[]): Stats {
  const bands = page.kind === 'rgb' ? data.slice(0, 3) : data.slice(0, 1);
  const length = bands[0]?.length ?? 0;
  const maxSamples = 1 << 20;
  const step = Math.max(1, Math.floor((length * bands.length) / maxSamples));
  const values: number[] = [];
  const noData = page.info.noData;
  for (const band of bands) {
    for (let i = 0; i < length; i += step) {
      const v = band[i];
      if (v === v && v !== noData && Number.isFinite(v)) values.push(v);
    }
  }
  if (values.length === 0) {
    return { min: 0, max: 1, p02: 0, p98: 1 };
  }
  const sorted = Float64Array.from(values).sort();
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { min: sorted[0], max: sorted[sorted.length - 1], p02: at(0.02), p98: at(0.98) };
}

function toneRange(page: Page, tone: ToneMode, stats_: Stats | undefined): [number, number] {
  const { bits, format } = page;
  if (!page.info.toneAdjustable) {
    // Unsigned integers of 8 bits or less (1, 2, 4, 8 ...).
    return [0, bits >= 8 ? 255 : (1 << bits) - 1];
  }
  const stats = stats_ ?? { min: 0, max: 1, p02: 0, p98: 1 };
  if (tone === 'full' && format !== 3) {
    return format === 2 ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1] : [0, 2 ** bits - 1];
  }
  if (tone === 'percentile') {
    return [stats.p02, stats.p98];
  }
  return [stats.min, stats.max];
}

/** Scale factor bringing an 8-bit-or-wider sample into 0..255 (for CMYK/YCbCr/Lab/alpha). */
function byteScale(page: Page): number {
  if (page.format === 3) return 255;
  if (page.bits === 8) return 1;
  return 255 / (2 ** page.bits - 1);
}

/**
 * Converts decoded samples to RGBA. `out` may be larger than `n` pixels; the
 * rest stays transparent. `stats` overrides the page statistics (partial data).
 */
export function toRGBA(
  page: Page,
  data: Sample[],
  n: number,
  tone: ToneMode,
  out = new Uint8ClampedArray(n * 4),
  stats = page.stats,
): Uint8ClampedArray {
  const noData = page.info.noData;
  const [lo, hi] = toneRange(page, tone, stats);
  const k = hi > lo ? 255 / (hi - lo) : 0;
  const mid = hi > lo ? 0 : 128;
  const colorCount = page.kind === 'gray' || page.kind === 'palette' ? 1 : page.kind === 'cmyk' ? 4 : 3;
  const alpha = data.length > colorCount ? data[colorCount] : null;
  const alphaScale = page.format === 3 ? 255 : page.bits === 8 ? 1 : page.bits === 16 ? 1 / 257 : 255 / (2 ** page.bits - 1);
  const bs = byteScale(page);
  const [c0, c1, c2, c3] = data;

  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const v0 = c0[i];
    if (v0 !== v0) {
      continue; // NaN or empty cell -> transparent
    }
    let r: number;
    let g: number;
    let b: number;
    switch (page.kind) {
      case 'gray': {
        if (v0 === noData) continue;
        let v = (v0 - lo) * k + mid;
        if (page.whiteIsZero) v = 255 - v;
        r = g = b = v;
        break;
      }
      case 'rgb': {
        const v1 = c1[i];
        const v2 = c2[i];
        if (noData !== null && v0 === noData && v1 === noData && v2 === noData) continue;
        r = (v0 - lo) * k + mid;
        g = (v1 - lo) * k + mid;
        b = (v2 - lo) * k + mid;
        break;
      }
      case 'palette': {
        if (v0 === noData) continue;
        const map = page.colorMap!;
        const size = map.length / 3;
        const idx = Math.max(0, Math.min(size - 1, v0 | 0));
        r = map[idx] / 257;
        g = map[size + idx] / 257;
        b = map[2 * size + idx] / 257;
        break;
      }
      case 'cmyk': {
        const kk = 1 - (c3[i] * bs) / 255;
        r = (255 - v0 * bs) * kk;
        g = (255 - c1[i] * bs) * kk;
        b = (255 - c2[i] * bs) * kk;
        break;
      }
      case 'ycbcr': {
        const y = v0 * bs;
        const cb = c1[i] * bs - 128;
        const cr = c2[i] * bs - 128;
        r = y + 1.402 * cr;
        g = y - 0.344136 * cb - 0.714136 * cr;
        b = y + 1.772 * cb;
        break;
      }
      case 'lab': {
        [r, g, b] = labToRgb(page, v0, c1[i], c2[i]);
        break;
      }
    }
    let a = 255;
    if (alpha) {
      a = alpha[i] * alphaScale;
      if (page.alphaAssociated && a > 0 && a < 255) {
        const f = 255 / a;
        r *= f;
        g *= f;
        b *= f;
      }
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}

function labToRgb(page: Page, l: number, a: number, b: number): [number, number, number] {
  if (page.format !== 3) {
    // 8-bit CIELab stores a* and b* as signed bytes; 16-bit as signed shorts.
    const half = 2 ** (page.bits - 1);
    const scale = page.bits === 8 ? 1 : 1 / 256;
    l = (l / (2 ** page.bits - 1)) * 100;
    a = (a >= half ? a - 2 * half : a) * scale;
    b = (b >= half ? b - 2 * half : b) * scale;
  }
  // CIELab in TIFF files (Photoshop, ICC) is relative to D50; adapt to sRGB (D65) with Bradford.
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const f = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = 0.96422 * f(fx);
  const y = f(fy);
  const z = 0.82521 * f(fz);
  const gamma = (c: number) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c);
  const r = gamma(3.1338561 * x - 1.6168667 * y - 0.4906146 * z);
  const g = gamma(-0.9787684 * x + 1.9161415 * y + 0.033454 * z);
  const bl = gamma(0.0719453 * x - 0.2289914 * y + 1.4052427 * z);
  return [r * 255, g * 255, bl * 255];
}
