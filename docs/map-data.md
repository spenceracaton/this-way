# Reusing neighborhood bundles

The imported maps are stored separately from the UI, sample listings, and seasonal
content. Reading the committed bundle does not require GitHub credentials, an API,
Python, or Leaflet. Rebuilding from the original inputs currently requires access
to the private FTW QA repository.

## Files

Read `public/data/neighborhood-import.json` for `importedIds` and the two
`retainedSampleMaps`. Every imported ID has these files:

| File under `public/` | Purpose |
| --- | --- |
| `data/{id}/neighborhood.json` | Name, projection, view bounds, approximate core coverage, artwork paths, and credits |
| `assets/neighborhoods/{id}.svg` | Editable neutral vector geography and core/nearby masks |
| `assets/neighborhoods/{id}.webp` | Lossless display image, capped at a 3072px long edge |
| `data/{id}/anchors.json` | Four geographic road vertices matched to SVG coordinates |
| `data/{id}/provenance.json` | Input hashes, mask hashes, transform notes, raster dimensions and checksums; newer batches also record exact source paths |
| `data/{id}/source-notices.json` | Newer batches' original source/feature credit and license statements, without copying all source geometry |

Paths beginning `./` in a configuration resolve relative to `public/`, not relative
to the configuration file. For example, Harbor Isle's `artwork` is
`./assets/neighborhoods/harbor-isle.svg`. The two retained sample maps have older
file layouts; use `public/neighborhoods.mjs` to find their configurations and keep
their illustrative listings out of a geography-only export.

The format is project-specific JSON, not a published versioned interchange
standard. An importer can iterate `importedIds` and read each configuration
without executing the application's JavaScript.

## Coordinates

For a geographic point with longitude `lng` and latitude `lat`, use its map's
`projection`:

```js
const x = p.xOrigin + (lng - p.lngOrigin) * p.xScale;
const y = p.yOrigin - (lat - p.latOrigin) * p.yScale;
// Inverse, for SVG points and coreBoundary vertices:
const lng = p.lngOrigin + (x - p.xOrigin) / p.xScale;
const lat = p.latOrigin - (y - p.yOrigin) / p.yScale;
```

This is a local linear drawing projection. SVG coordinates increase downward on
the y axis. Use each configuration's `bounds` to set the SVG/image viewBox; do not
assume all artwork fills the nominal `width` and `height`. `overviewBounds` frames
the core; `bounds` includes nearby artwork. To place the WebP, stretch it over the
same bounds. `coreBoundary` is in drawing coordinates. Independent anchors can
check a new renderer's coordinate conversion. OSM-derived anchors carry `osmType`
and `osmId`. Feather Sound anchors instead carry `sourceType`, `sourceId`, and
`sourceFeatureId` from the County road centerlines; consumers must not assume
every anchor is an OSM feature.

Coverage is approximate app geography, not official association boundaries,
surveyed shorelines, routing geometry, or parcel membership. The SVG masks are
presentation geometry. Neither the boundary nor the illustrated nearby blocks
establish address eligibility or safe walking access.

## Terms and provenance

Application code is MIT-licensed. OSM-derived data retains ODbL terms, while
separately attributed City/County/Esri source material keeps its own notices.
The illustrated artwork and its rasterizations remain copyright Spencer Caton,
with permission required for use in another work. See [LICENSE.md](../LICENSE.md).
This bundle format does not change those rights.

Preserve the configuration, provenance, and source notices together when sharing
an authorized bundle. A missing overall license field, such as Harbor Isle's,
does not imply an ODbL grant for its separately attributed County-derived patch.
The source notices preserve what the source actually declared. Original aerial
imagery pixels, FTW listings, and seasonal overlays are not included.
