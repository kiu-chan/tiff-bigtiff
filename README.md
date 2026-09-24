# tiff/bigtiff

View **TIFF** and **BigTIFF** images directly in VS Code, including files far larger than memory.

Open any `.tif`, `.tiff`, `.btf`, `.tf8` or `.tf2` file and it opens in the viewer.

## Features

- **Classic TIFF and BigTIFF** (64-bit offsets), little- and big-endian.
- **Huge images**: the image is shown as tiles, like a map. Only the tiles in view are read, at the level of detail the zoom needs: a rough overview first, then sharper tiles as they arrive. Multi-gigabyte files are never loaded whole, and tiles already shown are kept for panning and zooming back.
- **Gigapixel images without overviews** (e.g. whole-slide scans): the overview appears within about a second, zooming into any area shows it at full resolution almost immediately, and the zoomed-out view sharpens progressively, starting from the centre.
- **Fast JPEG**: JPEG tiles are decoded by the browser's native decoder, in parallel, and at 1/2, 1/4 or 1/8 size when that is all the zoom needs.
- **Pyramids / overviews** (e.g. Cloud Optimized GeoTIFF): the smallest level that is sharp enough is used automatically.
- **Multi-page** files: switch pages from the toolbar or with <kbd>PageUp</kbd> / <kbd>PageDown</kbd>.
- **Compression**: none, LZW, Deflate, JPEG, PackBits, Zstandard, WebP, LERC, and CCITT fax (modified Huffman RLE, Group 3, Group 4).
- **Pixel formats**: 1 to 64 bits per sample, unsigned and signed integers, 16/32/64-bit floating point, tiled or striped, chunky or planar.
- **Colour models**: grayscale (WhiteIsZero / BlackIsZero), RGB, palette, CMYK, YCbCr, CIE L\*a\*b\*, with alpha (associated or unassociated).
- **High bit depth and float data** are contrast-stretched: *min–max*, *2%–98%*, or the *full range* of the data type. NaN and GDAL NoData pixels are shown as transparent.
- **Pixel readout**: the status bar shows the coordinates and the raw sample values under the cursor.
- **Info panel**: format, byte order, dimensions, bit depth, compression, tiling, pyramid levels, and common tags (description, software, date, resolution, GeoTIFF EPSG code, …).
- Reloads automatically when the file changes on disk.

## Controls

| Action | Mouse / trackpad | Keyboard |
| --- | --- | --- |
| Zoom | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + wheel, pinch | <kbd>+</kbd> / <kbd>-</kbd> |
| Pan | Drag, scroll | Arrow keys (<kbd>Shift</kbd> for larger steps) |
| Fit to window | Double-click, **Fit** | <kbd>0</kbd> |
| Actual size (100%) | **1:1** | <kbd>1</kbd> |
| Next / previous page | Page selector | <kbd>PageDown</kbd> / <kbd>PageUp</kbd>, <kbd>]</kbd> / <kbd>[</kbd> |
| Info panel | **Info** | <kbd>I</kbd> |

## Using another editor for TIFF files

This viewer is registered as the default editor for TIFF files. To open a file with something else, right-click it and choose **Open With…**. To change the default, use the `workbench.editorAssociations` setting.

## Limitations

- Not supported: JPEG 2000 (e.g. some Aperio SVS), old-style JPEG (compression 6), LZMA, JPEG XL, and uncompressed chroma-subsampled YCbCr.
- Pyramid levels stored in SubIFDs (as in some OME-TIFF files) are not used; those images are rendered from full resolution.
- A sharp whole-image view of a huge image without pyramid levels needs every tile of the file, so zoomed all the way out it sharpens over a while (about 2 minutes for a 52-gigapixel, 9 GB slide); a rough overview is shown meanwhile. Zooming in only reads the area in view.

## Development

```sh
npm install
npm run build          # bundle into dist/
npm run typecheck
python3 test/make_fixtures.py   # needs numpy, tifffile, imagecodecs, Pillow
npm test               # decoder tests against the fixtures
npm run package        # build tiff-bigtiff-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

### How it works

- `src/tiffEditor.ts`: the custom editor in the extension host. It serves byte ranges of the file with positional reads.
- `src/webview/main.ts`: the viewer UI: canvas, zoom/pan, the display tile pyramid, info panel.
- `src/webview/worker.ts`: a Web Worker that parses and decodes the TIFF with [geotiff.js](https://github.com/geotiffjs/geotiff.js), using a block-cached byte-range source (`messageSource.ts`).
- `src/webview/tiff.ts`: page/pyramid discovery, chunked region reading with box-filter or nearest-neighbour downsampling, and colour conversion.
- `src/webview/ccitt.ts`: CCITT T.4 / T.6 fax decoder.
- `src/webview/jpeg.ts`: JPEG tile decoding with the browser's native decoder, optionally at reduced size (geotiff.js' decoder as fallback).

## License

[MIT](LICENSE). Bundles [geotiff.js](https://github.com/geotiffjs/geotiff.js) (MIT).
