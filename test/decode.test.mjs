// Decoder tests: runs the worker's TIFF pipeline (src/webview/tiff.ts) under Node
// against the fixtures produced by test/make_fixtures.py.
//
//   python3 test/make_fixtures.py && npm test
//
// Set DUMP_PNG=1 to also write the rendered previews to test/out/ for inspection.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'test', 'fixtures');
const outDir = join(root, 'test', 'out');
if (!existsSync(fixtures)) {
  console.error('Missing test/fixtures. Run: python3 test/make_fixtures.py');
  process.exit(1);
}

const bundle = join(root, 'dist', 'test', 'tiff.mjs');
await esbuild.build({
  stdin: {
    contents: `export * from './src/webview/tiff.ts'; export { MessageSource } from './src/webview/messageSource.ts';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'error',
});
const lib = await import(pathToFileURL(bundle).href);

async function openFixture(name) {
  const handle = await open(join(fixtures, name), 'r');
  const size = (await handle.stat()).size;
  let reads = 0;
  const source = new lib.MessageSource(size, async (ranges) => {
    reads++;
    return Promise.all(
      ranges.map(async ({ offset, length }) => {
        const buf = new Uint8Array(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return buf.buffer.slice(0, bytesRead);
      }),
    );
  });
  const tiff = await lib.openTiff(source);
  return { ...tiff, close: () => handle.close(), reads: () => reads };
}

async function render(page, window, outWidth, outHeight, tone = 'minmax') {
  const { image, window: levelWindow } = lib.chooseLevel(page, window, outWidth);
  const region = await lib.readRegion(page, image, levelWindow, outWidth, outHeight);
  if (page.info.toneAdjustable) page.stats ??= lib.computeStats(page, region.data);
  return { rgba: lib.toRGBA(page, region.data, outWidth * outHeight, tone), image, width: outWidth, height: outHeight };
}

function renderFull(page, tone) {
  return render(page, [0, 0, page.info.width, page.info.height], page.info.width, page.info.height, tone);
}

function loadNpy(name) {
  const buf = readFileSync(join(fixtures, name));
  const headerLen = buf.readUInt16LE(8);
  const header = buf.subarray(10, 10 + headerLen).toString('latin1');
  const shape = /'shape': \(([^)]*)\)/.exec(header)[1].split(',').filter(Boolean).map(Number);
  return { shape, data: new Uint8Array(buf.buffer, buf.byteOffset + 10 + headerLen) };
}

function pixel(result, x, y) {
  const o = (y * result.width + x) * 4;
  return Array.from(result.rgba.subarray(o, o + 4));
}

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function writePng(file, { rgba, width, height }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const dump = process.env.DUMP_PNG === '1';
if (dump) mkdirSync(outDir, { recursive: true });

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

/** `tolerance` is the max per-channel difference, or `{ mean }` for lossy data. */
function assertMatchesRgb(result, tolerance, name) {
  const refName = `${name.replace(/\.tif$/, '')}_reference.npy`;
  const rgbRef = loadNpy(existsSync(join(fixtures, refName)) ? refName : 'rgb8_reference.npy');
  const [h, w] = rgbRef.shape;
  assert.equal(result.width, w);
  assert.equal(result.height, h);
  let worst = 0;
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(result.rgba[i * 4 + c] - rgbRef.data[i * 3 + c]);
      worst = Math.max(worst, d);
      sum += d;
    }
    assert.equal(result.rgba[i * 4 + 3], 255);
  }
  if (typeof tolerance === 'number') {
    assert.ok(worst <= tolerance, `max channel difference ${worst} > ${tolerance}`);
  } else {
    const mean = sum / (w * h * 3);
    assert.ok(mean <= tolerance.mean, `mean channel difference ${mean.toFixed(2)} > ${tolerance.mean}`);
  }
}

async function withFixture(name, fn) {
  const tiff = await openFixture(name);
  try {
    const result = await fn(tiff);
    if (dump && result?.rgba) writePng(join(outDir, name.replace(/\.tif$/, '.png')), result);
  } finally {
    await tiff.close();
  }
}

console.log('RGB');
for (const [name, tolerance] of [
  ['rgb8_strips_none.tif', 0],
  ['rgb8_tiled_lzw_pred.tif', 0],
  ['rgb8_deflate_bigendian.tif', 0],
  ['rgb8_packbits.tif', 0],
  ['rgb8_planar_separate.tif', 0],
  ['rgb8_zstd.tif', 0],
  // geotiff.js upsamples JPEG chroma with nearest neighbour, libjpeg interpolates.
  ['rgb8_jpeg_rgb.tif', { mean: 2 }],
  ['bigtiff_rgb8_tiled_jpeg.tif', { mean: 2 }],
  ['ycbcr_jpeg.tif', { mean: 2 }],
  ['cmyk8.tif', 2],
  // Pillow's own RGB -> Lab conversion is approximate.
  ['cielab8.tif', 20],
]) {
  await test(name, () =>
    withFixture(name, async (tiff) => {
      const result = await renderFull(tiff.pages[0]);
      assertMatchesRgb(result, tolerance, name);
      return result;
    }),
  );
}

await test('bigtiff flag', () =>
  withFixture('bigtiff_rgb8_tiled_jpeg.tif', async (tiff) => {
    assert.equal(tiff.info.bigTiff, true);
    assert.equal(tiff.info.pages[0].compression, 'JPEG');
  }),
);

await test('palette8.tif', () =>
  withFixture('palette8.tif', async (tiff) => {
    assert.equal(tiff.pages[0].kind, 'palette');
    const result = await renderFull(tiff.pages[0]);
    const [r, g, b] = pixel(result, 200, 150);
    assert.ok(r > 200 && g < 60 && b < 60, `expected red, got ${[r, g, b]}`);
    return result;
  }),
);

await test('rgba8_unassoc_alpha.tif', () =>
  withFixture('rgba8_unassoc_alpha.tif', async (tiff) => {
    assert.equal(tiff.info.pages[0].hasAlpha, true);
    const result = await renderFull(tiff.pages[0]);
    assert.equal(pixel(result, 0, 10)[3], 0);
    assert.equal(pixel(result, 399, 10)[3], 255);
    return result;
  }),
);

console.log('Gray / high bit depth');
await test('gray16_deflate.tif (min-max stretch)', () =>
  withFixture('gray16_deflate.tif', async (tiff) => {
    const page = tiff.pages[0];
    assert.equal(page.info.toneAdjustable, true);
    const result = await renderFull(page, 'minmax');
    assert.deepEqual(pixel(result, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(result, 0, 299), [255, 255, 255, 255]);
    const full = await renderFull(page, 'full');
    assert.ok(pixel(full, 0, 299)[0] < 40, 'full range of a 16-bit image should be dark');
    return result;
  }),
);

await test('bigtiff_gray16_lzw.tif', () =>
  withFixture('bigtiff_gray16_lzw.tif', async (tiff) => {
    assert.equal(tiff.info.bigTiff, true);
    const result = await renderFull(tiff.pages[0]);
    assert.equal(pixel(result, 0, 0)[0], 0);
    assert.equal(pixel(result, 399, 0)[0], 255);
    return result;
  }),
);

await test('int16_signed.tif', () =>
  withFixture('int16_signed.tif', async (tiff) => {
    const result = await renderFull(tiff.pages[0]);
    assert.equal(pixel(result, 0, 0)[0], 0);
    assert.equal(pixel(result, 399, 0)[0], 255);
    const values = await lib.readPixel(tiff.pages[0], 0, 0);
    assert.deepEqual(values, [-20000]);
    return result;
  }),
);

for (const name of ['float32_nan_zstd_pred.tif', 'float64_gray.tif']) {
  await test(name, () =>
    withFixture(name, async (tiff) => {
      const page = tiff.pages[0];
      assert.equal(page.info.fullRangeAvailable, false);
      const result = await renderFull(page);
      assert.equal(pixel(result, 5, 5)[3], 0, 'NaN should be transparent');
      assert.equal(pixel(result, 200, 200)[3], 255);
      return result;
    }),
  );
}

console.log('Bilevel / CCITT');
const bilevelRef = loadNpy('bilevel_reference.npy');
for (const name of ['bilevel_none.tif', 'bilevel_packbits.tif', 'bilevel_rle.tif', 'bilevel_g3.tif', 'bilevel_g4.tif']) {
  await test(name, () =>
    withFixture(name, async (tiff) => {
      const page = tiff.pages[0];
      const result = await renderFull(page);
      const [h, w] = bilevelRef.shape;
      let mismatches = 0;
      for (let i = 0; i < w * h; i++) {
        const expected = bilevelRef.data[i] ? 255 : 0;
        if (result.rgba[i * 4] !== expected) mismatches++;
      }
      assert.equal(mismatches, 0, `${mismatches} pixels differ (${page.info.compression})`);
      // Downsampled preview averages to grey levels.
      const small = await render(page, [0, 0, w, h], 425, 550);
      assert.equal(small.width, 425);
      return result;
    }),
  );
}

console.log('Structure');
await test('multipage.tif', () =>
  withFixture('multipage.tif', async (tiff) => {
    assert.equal(tiff.pages.length, 3);
    assert.deepEqual(
      tiff.info.pages.map((p) => [p.width, p.height]),
      [[400, 300], [200, 150], [400, 300]],
    );
    const second = await renderFull(tiff.pages[1]);
    assert.equal(second.width, 200);
    return second;
  }),
);

await test('pyramid_bigtiff.tif uses overviews', () =>
  withFixture('pyramid_bigtiff.tif', async (tiff) => {
    const page = tiff.pages[0];
    assert.equal(tiff.pages.length, 1);
    assert.deepEqual(
      page.info.levels.map((l) => l.width),
      [3200, 1600, 800, 400],
    );
    const readsBefore = tiff.reads();
    const preview = await render(page, [0, 0, 3200, 2400], 400, 300);
    assert.equal(preview.image.getWidth(), 400, 'preview should come from the smallest overview');
    assert.ok(tiff.reads() - readsBefore < 20, `too many reads: ${tiff.reads() - readsBefore}`);
    // Full-resolution detail window: red square of tile (1,1) at (1350..1450, 400..500)
    const detail = await render(page, [1300, 350, 1500, 550], 200, 200);
    assert.equal(detail.image.getWidth(), 3200);
    assert.deepEqual(pixel(detail, 100, 100), [255, 0, 0, 255]);
    return preview;
  }),
);

await test('nearest sampling for huge windows skips work', () =>
  withFixture('rgb8_tiled_lzw_pred.tif', async (tiff) => {
    const page = tiff.pages[0];
    const result = await render(page, [0, 0, 400, 300], 4, 3);
    assert.equal(result.width, 4);
    assert.equal(result.rgba.length, 4 * 3 * 4);
  }),
);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
