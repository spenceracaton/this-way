# Continuous canvas art preparation

This is an art and geometry preparation note for the two-map canvas study. It does not establish a seamless transition or validate either source map's geographic accuracy. The original illustrations and metadata remain untouched.

## Retained art and geographic placement

`public/prototypes/continuous-map/data/artwork.json` lists the Old Northeast and Crescent Lake derivatives. Their bounds come from inverting the `projection` in each retained `neighborhood.json` at the four corners of its declared image bounds. This is the current affine placement carried into a common geographic map. It is not a fitted correction.

| Art | Geographic image bounds `[south, west]` to `[north, east]` | Prepared pixels | Full / spotlight bytes | Estimated decoded RGBA |
| --- | --- | ---: | ---: | ---: |
| Old Northeast | 27.774825, -82.641824 to 27.802279, -82.618147 | 1560 × 2048 | 171,598 / 158,946 | 12,779,520 bytes |
| Crescent Lake | 27.782905, -82.648064 to 27.793118, -82.637199 | 1928 × 2048 | 112,054 / 85,720 | 15,794,176 bytes |

The image rectangles overlap from 27.782905, -82.641824 to 27.793118, -82.637199. That is about 7.27% of the Old Northeast rectangle and 42.57% of the Crescent Lake rectangle by approximate ground area. Their union covers 27.774825, -82.648064 to 27.802279, -82.618147. These are rectangle calculations only; they say nothing about whether streets, labels, shorelines, or landmarks agree in the overlap.

The original source rasters are 3,220 × 4,228 and 3,840 × 4,080 pixels. The preparation script scales each to a 2,048-pixel maximum edge with Lanczos resampling, then writes WebP at quality 90. It also writes a separate spotlight derivative from each SVG's authored `spotlight` path. The path is sampled at half-unit intervals, rasterized with its authored stroke, then applied to the source raster alpha before resize. This keeps both versions bounded while allowing the renderer to load only the selected full or spotlight version.

The prepared resolutions represent different ground scales: roughly 1.49 m per Old Northeast pixel and 0.55 m per Crescent Lake pixel near these maps' centers. Their baked labels therefore will not have equal screen size or sharpness at the same geographic zoom. Text legibility at zooms 15–17 is an open rendered-review question; the scale values alone do not demonstrate that labels are readable.

Both SVGs use the spotlight to emphasize the featured area while retaining dimmer geography outside it. The extracted alpha derivative is therefore an art-presentation option. It is not a service-eligibility geometry or an official neighborhood edge. The Old Northeast metadata's `coreBoundary` is deliberately not used. The spotlight variants also retain baked source labels and roads inside their masks, so duplicated content remains possible when both images are shown together.

`sourceSha256` identifies each unchanged SVG; `sourceRasterSha256` identifies the unchanged WebP source. `bytes` and `maskBytes` are compressed transfer sizes. `decodedBytes` and `maskDecodedBytes` are width × height × 4 estimates for an RGBA buffer, not measured Safari, canvas, or GPU memory. If one version of each illustration is resident, the estimated image buffers total 28,573,696 bytes (about 27.25 MiB); the browser can require additional copies and overhead. Keeping full and spotlight versions decoded together would double that image-buffer estimate.

## Registration evidence and limits

The existing transforms are retained as supplied. No registration fitting has occurred. A common geographic camera can place the images analytically, but this does not prove that their depicted roads match independent geographic data. No independent held-out street-intersection coordinates for these two maps are present in the retained data, so geographic residuals cannot be honestly reported yet.

Before any fitting, acquire and hash an independent street-centerline source and name at least 12 intersections per map: eight fitting anchors (four near image edges and four internal) and four reserved held-out intersections. Do not fit on the held-out points. Existing source-derived markers and the transform's own control points do not count as independent validation. The criteria recorded in `public/prototypes/continuous-map/data/alignment.json` are:

- Inspect at zoom levels 15, 16, and 17.
- Require a maximum held-out residual of 10 m (5 screen pixels at zoom 16).
- Across the overlap and one deliberately unillustrated gap, require distinct and understandable street paths, no duplicated or conflicting road/place labels, and visible neutral context. An ambiguous road continuation or displaced landmark fails.
- Review the crossing with each full-art and source-spotlight mode. Do not treat spotlight edges as ownership or eligibility boundaries.

The criteria are frozen, but the named anchor set is blocked until independent intersections are sourced and hashed. Do not begin fitting or claim a pass before then. Even after that measurement, inspect rendered crossings and label ownership separately: a low numerical residual alone does not prove a useful composition. The initial art files contain baked labels and roads, and no overlap render review has cleared a dual-art seam. The parent canvas study must decide image ordering or focused-art behavior through actual renders; this preparation does not choose an owner for overlapping pixels.

## Read-only source-road agreement cross-check

`scripts/assess-continuous-alignment.py` compares every retained named road vertex to the nearest County road segment with an exactly equal normalized full road name. Normalization handles case and punctuation, spelled or numeric ordinals, full direction words, and common County road-type abbreviations. It does not use substring matching. Distances use a local equirectangular metric approximation. Screen-pixel values convert those distances at Web Mercator zooms 15, 16, and 17.

| Source art | Road features with same-name County lines | Missing name features | Matched source vertices | Median / p95 / max distance (m), all vertices | p95 / max inside County context bounds (m) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Old Northeast | 262 / 274 | 12 | 2,311 | 1.140 / 19.746 / 865.583 | 7.944 / 114.000 |
| Crescent Lake | 4 / 4 | 0 | 21 | 0.545 / 5.194 / 5.310 | 5.194 / 5.310 |

The all-vertex Old Northeast maximum occurs on a Brightwaters Boulevard Northeast vertex outside the County context bounds; 90 matched source vertices lie outside those bounds. The worst in-bounds same-name distance is about 114 m on Snell Isle Boulevard Northeast. Same-name nearest-line matching cannot determine whether that is a local source-road mismatch or a wrong segment association. Twelve Old Northeast source road feature names have no exact normalized County-name match; the list is retained in `public/prototypes/continuous-map/data/alignment.json`.

| Source art | Zoom 15 median / p95 / max (px) | Zoom 16 median / p95 / max (px) | Zoom 17 median / p95 / max (px) |
| --- | ---: | ---: | ---: |
| Old Northeast | 0.27 / 4.67 / 204.81 | 0.54 / 9.34 / 409.62 | 1.08 / 18.69 / 819.24 |
| Crescent Lake | 0.13 / 1.23 / 1.26 | 0.26 / 2.46 / 2.51 | 0.52 / 4.92 / 5.03 |

These figures compare retained road coordinates with independent County road coordinates; they do not measure artwork registration residuals, do not use held-out intersections, and do not support transform correction. County coverage is bounded by its source extent; full-name omissions are recorded rather than counted as positional errors. Each vertex is weighted equally, and nearest-segment matching can associate a vertex with a different piece of a repeated or segmented road name. The full input SHA-256 values are recorded under `sourceRoadAgreement.inputs` so the measurements are tied to the exact retained files.

The first canvas renders also showed a substantial baked-label scale mismatch between the two illustrations. The source spotlight variants did not produce clean ownership joins across the overlap. Those visual findings remain open; the numeric road-coordinate cross-check does not clear them.

## Rebuild

Run `python3 scripts/prepare-continuous-art.py` from the repository root to rebuild art metadata and derivatives. Run `python3 scripts/assess-continuous-alignment.py` to refresh the read-only source-road comparison in `public/prototypes/continuous-map/data/alignment.json`. The comparison reads the three hashed inputs and only updates that report section.
