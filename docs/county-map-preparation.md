# Preparing new Pinellas maps

The 87-map catalog exhausts the prepared bundles found in the pinned FTW source
audit. New areas need fresh geography. The first research candidates are
Greenbriar, Harbor Bluffs, and South Highpoint, in that order. Greenbriar and Harbor Bluffs passed source and mobile-design review and are registered in this branch. South Highpoint is preserved as an unregistered source study because the current coverage model cannot represent its full geometry.

[The candidate queue](../scripts/county-map-candidates.json) separates research
from accepted maps. Its Census-designated-place reference areas are not association
boundaries or parcel membership. County road centerlines and USGS water are
separate sources; each retains its own metadata and terms. No listing, residence,
photo, seasonal overlay, or participation records are part of this work.

## One neighborhood per iteration

1. Query the exact reference-area name and verify it is the intended Pinellas
   area. Preserve the original feature ID, all geometry parts and holes, source
   URLs, response checksums, and retrieval time. Ambiguous names or unsupported
   geometry stop the attempt rather than producing a guessed outline.
2. Acquire all road and water records for the reference extent. Reconcile object
   IDs across pages; a truncated or duplicate response must fail. Bind names and
   road classes from inspected service metadata, not guessed field names.
3. Draw a neutral preview in a cloud scratch directory. Keep raw geographic
   inputs separately reusable. Verify four spatially separated source-to-artwork
   anchors, masks, credits, and source terms. Keep the source and raster hashes.
4. Inspect actual WebKit renders at 390×664, 320×568, and 664×390, including zoom
   and picker states. Have UX and visual reviewers critique the results. Revise
   concrete issues and repeat the affected checks.
5. Record the result, failed assumptions, request/byte counts, rendered/reused
   assets, validation results, and the specific process change for the next
   neighborhood. Finish this reflection before starting the next candidate.
6. Promote a verified bundle through a focused ordinary PR, required checks,
   auto-merge, and exact-main production verification under `AGENTS.md`.

Do not change the catalog count when only a queue entry, source snapshot, or
preview exists. The current application model's single-ring coverage must not
silently discard parts or holes from a new reference boundary.

## Greenbriar iteration — November 3, 2026

GIS access is now verified. The initial blocked-network attempt made no map;
that blocker is resolved and requires no further environment configuration.

- Identity: Census TIGERweb January 1, 2026 CDP boundary, GEOID `1227360`,
  `Greenbriar CDP`, Florida. Its 111 unique boundary vertices fall within the
  Pinellas County reference polygon. The closed ring has no self-intersections.
  This is CDP reference coverage, not an association or parcel boundary. FDOT
  corroborates identity but has an undated, different outline; use dated Census.
- Acquisition: one complete core, 236 County road records, 16 USGS waterbody
  records, and zero Area records. An independent count query confirms the empty
  Area result. All object IDs reconcile across pages; output requests EPSG:4326.
  The raw snapshot totals approximately 1.2 MB; metadata and file hashes are saved.
- Reuse: `geography/sources/greenbriar-cdp/` contains the original geographic
  coordinates and minimal source identities, separate from SVG/WebP artwork.
  County disclaimer/credit and Census/USGS metadata remain source-specific;
  there is no invented blanket license or private editor/address-range data.
- Rendering: four source road anchors, one new raster and 85 retained rasters.
  No seasonal artwork, listings, photos or participation data are imported.
- Design critique: the floating empty-state card covered lower streets on phones.
  Move it below the mobile map and fit the overview between title and attribution.
  Revised phone (390×664), narrow (320×568), landscape (664×390), zoom and picker
  captures passed independent UX and visual reviews. Credits retain a 6px gap
  above the empty-state strip. Physical iPhone gestures remain unverified.
- Process reflection: offline fixtures had guessed NHD layer names and did not
  model ArcGIS's `objectIds:null` for a genuinely empty layer. Discover the live
  polygon layers by inspected metadata; accept null only for optional water
  when a separate exact count is zero. Prefer dated Census CDP geography over
  an undated derivative. Request only the fields used by the geographic package.
- Next iteration: apply these verified bindings and the revised empty-state
  layout to Harbor Bluffs. Review its coastal geometry before promoting it.

## Harbor Bluffs iteration — November 3, 2026

- Identity: Census January 1, 2026 `Harbor Bluffs CDP`, GEOID `1228650`,
  one closed/simple 124-position core ring. The same-vintage Pinellas County
  polygon covers the complete core, not just its vertices.
- Acquisition: 14 helper HTTP requests, 410 road records, three Waterbody and
  two Area records; complete object-ID reconciliation with no null-ID fallback.
  The source snapshot is 56,795,636 bytes; the initial reusable package was
  16,995,524 bytes. Its final GeoJSON is 7,050,822 bytes after removing JSON
  whitespace, with every parsed feature/coordinate verified unchanged. All core/road/water geometry is valid under independent
  Shapely checks and matches the snapshot coordinates exactly.
- Critique: coastal NHD features extend far outside this small coverage area.
  The two Area features contain 1,425 rings and 174,239 positions. Do not discard
  parts or simplify them silently. Preserve source geometry for reuse; the app
  loads the compact WebP rather than downloading GeoJSON or SVG during normal use.
- Rendering: four anchors, one new raster and 86 retained rasters. Actual WebKit
  phone/narrow/landscape/zoom/picker renders passed UX and visual review without
  another layout change. Coastal water remains reference artwork, not a surveyed
  shoreline or access claim. No listings or seasonal overlays were added.
- Process reflection: use one immutable acquisition and reuse the same source
  package for artwork and review, avoiding duplicate requests. Record input bytes
  as well as record counts: five water features can outweigh hundreds of roads.
  Compact serialization reduces transfer/storage overhead without simplifying
  source coordinates; metadata stays human-readable.
  The portable packager now separately rejects malformed geometry even when a
  snapshot's checksums are internally consistent; valid parts, holes and Z remain.
- Next iteration: inspect South Highpoint with the same verified metadata
  bindings; check geometry complexity and byte size before investing in rendering.

## South Highpoint iteration — November 3, 2026

- Identity: Census January 1, 2026 `South Highpoint CDP`, GEOID `1267462`,
  Florida. One exact-name/state query returns one feature (66,548 response bytes).
- Geometry: 19 rings, 660 positions, nine polygon components and ten holes.
  The complete MultiPolygon is valid under Shapely and is covered/contained by
  the same-vintage Pinellas County polygon.
- Result: stop before road/water acquisition or rendering. The application and
  server currently share single-ring coverage; choosing the largest component
  or filling holes would incorrectly expand or reduce submission eligibility.
  The complete core is retained under `geography/studies/south-highpoint-cdp/`;
  it is absent from the picker and server coverage registry.
- Process reflection: checking core shape before acquiring context avoids a
  potentially large, unusable download and artwork review. The next work for this
  area is an explicit shared MultiPolygon/hole coverage model with inside/outside
  tests, followed by the same source and rendered critique loop. This is deferred
  beyond the two-map release; no partial South Highpoint map is counted.

## Batch validation

The two accepted maps bring the catalog from 87 to 89; South Highpoint does not
increase that count. All 102 Node/local Worker/D1/R2 checks passed. The complete
Chromium/phone-WebKit browser suite passed 251 checks with five intentional
project-specific skips. The isolated real-service submission/private-upload/
owner-approval journey passed in both engines. Final UX, visual and independent
code reviews found no remaining blocker. Existing raster hashes were retained;
a repeat raster pass rendered zero and retained all 87 geography-only outputs.

## Reproduce a candidate

```sh
python3 scripts/acquire-county-geography.py \
  --name Greenbriar --candidate-id greenbriar-cdp \
  --boundary-name-field BASENAME --boundary-id-field GEOID --boundary-id 1227360 \
  --road-name-field FULLNAME --road-class-field ROADCLASS \
  --output /workspace/design-review/county-candidates/greenbriar-source-NEW
python3 scripts/package-county-geography.py \
  --snapshot /workspace/design-review/county-candidates/greenbriar-source-NEW \
  --county-terms /workspace/design-review/county-live/county-road-item.json \
  --id greenbriar-cdp --name Greenbriar --output /tmp/greenbriar-package-NEW
python3 scripts/build-county-map.py \
  --source geography/sources/greenbriar-cdp --output-root /tmp/greenbriar-preview
```

The acquisition destination must be new and outside `public/`. The tool stages
all source features, raw metadata, actual field bindings, counts and checksums
before installing the snapshot. Fetch the County service item's terms JSON
from the item URL recorded in `source.json` before packaging a fresh snapshot.
The package and renderer need no production credentials; committed packages
rebuild offline. Neither command registers a map in the public catalog.

Ambiguous source identities, missing records, truncated responses, unsupported
coordinates, or multipart/holed core coverage stop the attempt. Water polygons
retain all components and holes. A successful download still needs source,
geometry and rendered mobile reviews before catalog admission.
