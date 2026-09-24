# Changelog

## 0.1.0

- Tiled rendering: only the tiles in view are read, at the level of detail the zoom needs, coarse levels first; rendered tiles are kept for panning and zooming back.
- Huge single-level images (e.g. whole-slide scans) show an overview within about a second, and zooming into any area shows it at full resolution almost immediately.
- JPEG tiles are decoded with the browser's native decoder, many times faster, and at reduced size for zoomed-out views.
- Values are read directly from decoded tiles, only where they are needed.
- Loading progress is shown as a percentage in the status bar.

- First release: TIFF/BigTIFF viewer with on-demand reading of large files, pyramid support, multi-page navigation, contrast stretching for high bit depth and float data, pixel readout, info panel, and CCITT fax decoding.
