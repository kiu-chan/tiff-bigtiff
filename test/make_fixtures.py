"""Generates TIFF test files covering the formats the viewer supports.

Requires: numpy, tifffile, imagecodecs, Pillow (with libtiff).
Usage: python3 test/make_fixtures.py
"""
import os
import numpy as np
import tifffile
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), 'fixtures')
os.makedirs(OUT, exist_ok=True)


def path(name):
    return os.path.join(OUT, name)


h, w = 300, 400
yy, xx = np.mgrid[0:h, 0:w]
rgb8 = np.stack([(xx * 255 // (w - 1)), (yy * 255 // (h - 1)), ((xx + yy) % 256)], -1).astype(np.uint8)
rgb8[100:200, 150:250] = [255, 0, 0]
gray8 = rgb8[..., 0].copy()

tifffile.imwrite(path('rgb8_strips_none.tif'), rgb8, photometric='rgb')
tifffile.imwrite(path('rgb8_tiled_lzw_pred.tif'), rgb8, photometric='rgb', tile=(64, 64), compression='lzw', predictor=True)
tifffile.imwrite(path('rgb8_deflate_bigendian.tif'), rgb8, photometric='rgb', compression='zlib', byteorder='>')
tifffile.imwrite(path('rgb8_packbits.tif'), rgb8, photometric='rgb', compression='packbits')
tifffile.imwrite(path('rgb8_planar_separate.tif'), np.moveaxis(rgb8, -1, 0), photometric='rgb', planarconfig='separate')
tifffile.imwrite(path('rgb8_zstd.tif'), rgb8, photometric='rgb', compression='zstd', tile=(128, 128))
tifffile.imwrite(path('rgb8_jpeg_rgb.tif'), rgb8, photometric='rgb', compression='jpeg', tile=(128, 128))
tifffile.imwrite(path('bigtiff_rgb8_tiled_jpeg.tif'), rgb8, photometric='rgb', compression='jpeg', tile=(128, 128), bigtiff=True)
tifffile.imwrite(path('bigtiff_gray16_lzw.tif'), (xx * 50 + 1000).astype(np.uint16), bigtiff=True, compression='lzw')

rgba = np.dstack([rgb8, (xx * 255 // (w - 1)).astype(np.uint8)])
tifffile.imwrite(path('rgba8_unassoc_alpha.tif'), rgba, photometric='rgb', extrasamples=['unassalpha'])

gray16 = (yy * 12 + 3000).astype(np.uint16)
tifffile.imwrite(path('gray16_deflate.tif'), gray16, compression='zlib')
tifffile.imwrite(path('int16_signed.tif'), (xx - 200).astype(np.int16) * 100)

f32 = np.sin(xx / 30.0).astype(np.float32) * np.cos(yy / 25.0).astype(np.float32)
f32[0:40, 0:40] = np.nan
tifffile.imwrite(path('float32_nan_zstd_pred.tif'), f32, compression='zstd', predictor=True, tile=(64, 64))
tifffile.imwrite(path('float64_gray.tif'), f32.astype(np.float64))

# Multi-page with different sizes
with tifffile.TiffWriter(path('multipage.tif')) as tw:
    tw.write(rgb8, photometric='rgb')
    tw.write(gray8[:150, :200], photometric='minisblack')
    tw.write(gray16, compression='lzw')

# Pyramid (COG-like): full resolution + reduced-resolution overviews
big = np.tile(rgb8, (8, 8, 1))  # 2400 x 3200
with tifffile.TiffWriter(path('pyramid_bigtiff.tif'), bigtiff=True) as tw:
    tw.write(big, photometric='rgb', tile=(256, 256), compression='zlib', subfiletype=0)
    for f in (2, 4, 8):
        tw.write(big[::f, ::f], photometric='rgb', tile=(256, 256), compression='zlib', subfiletype=1)

# Pillow / libtiff produced variants
pil_rgb = Image.fromarray(rgb8)
pil_rgb.convert('P', palette=Image.ADAPTIVE, colors=64).save(path('palette8.tif'))
pil_rgb.convert('CMYK').save(path('cmyk8.tif'))
pil_rgb.save(path('ycbcr_jpeg.tif'), compression='jpeg')
pil_rgb.convert('LAB').save(path('cielab8.tif'))

doc = Image.new('1', (1700, 2200), 1)
from PIL import ImageDraw
d = ImageDraw.Draw(doc)
for i in range(40):
    d.text((100, 60 + i * 50), f'Line {i}: The quick brown fox jumps over the lazy dog 0123456789', fill=0)
d.rectangle((1200, 1500, 1600, 2000), outline=0, width=9)
d.ellipse((1250, 1550, 1550, 1950), fill=0)
doc.save(path('bilevel_none.tif'))
doc.save(path('bilevel_g4.tif'), compression='group4')
doc.save(path('bilevel_g3.tif'), compression='group3')
doc.save(path('bilevel_packbits.tif'), compression='packbits')
doc.save(path('bilevel_rle.tif'), compression='tiff_ccitt')
np.save(path('bilevel_reference.npy'), np.array(doc, dtype=np.uint8))
np.save(path('rgb8_reference.npy'), rgb8)
# Lossy files are compared with libjpeg's decoding (through tifffile / imagecodecs).
for name in ('rgb8_jpeg_rgb', 'bigtiff_rgb8_tiled_jpeg', 'ycbcr_jpeg'):
    np.save(path(name + '_reference.npy'), tifffile.imread(path(name + '.tif')))
print('fixtures written to', OUT)
