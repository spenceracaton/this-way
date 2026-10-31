# iPhone artwork comparison

Open `/?diagnostic=1&artwork=full` on the physical iPhone. Use the links above
the map to switch between Full SVG and Rasterized artwork. Plain rectangle is
retained as the earlier control.

Full SVG and Rasterized artwork use the same Leaflet map, bounds, projection,
four pins, gesture handling, and PR #4 zoom settings. The raster is a lossless
3220 x 4228 WebP pre-rendered from the same SVG, then displayed through
Leaflet's ImageOverlay. The default URL uses the raster map and has no
diagnostic controls. Full SVG remains available only through the diagnostic
URL for comparison.

For each version:

1. Reset, pinch to zoom, then immediately pan with one finger.
2. Reset, repeat the pinch, pause one second, then pan.
3. Switch between Full SVG and Rasterized artwork and repeat at a similar zoom
   level. Try both orders.

Report whether the immediate pan is smooth in both, only in Rasterized artwork,
or neither. Also note whether the raster looks acceptably sharp at the zoom
levels you would actually use. This comparison collects no telemetry or device
trace.

A clear improvement with Rasterized artwork supports retaining SVG as the
editable source while serving pre-rendered artwork, potentially in multiple
resolutions or tiles. Similar lag in both leaves image-overlay resizing or other
map work as candidates. Neither outcome alone identifies Safari layout, paint,
or compositing as the cause; that needs a device trace.

The raster was produced from the committed SVG at four times its 805 x 1057
viewBox dimensions. Do not simplify geographic paths or replace masks based
only on SVG element counts. Chromium and phone-sized WebKit checks verify map
geometry and interaction consistency, not iPhone frame timing. Second-
neighborhood work remains on its separate branch during this test.
