# Five-map follow-on review

Baseline: main/live `fc78e6648a13408552a59e6a75d85fbb5e9a2608`, 89 accepted maps.
This batch proceeds one area at a time through source acquisition, rendered
mobile critique, revision and recorded reflection before the next acquisition.
No seasonal overlays, listings, photos or resident data are imported.

## Boundary screening

The January 1, 2026 Census [CDP layer 5](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/5)
returned all 21 records intersecting the Pinellas bounding extent. Exact geometry
checks against the same-vintage Census Pinellas County polygon excluded neighboring
counties. Only Bear Creek, Ridgecrest and Tierra Verde were new, compact, valid
single-exterior CDPs. Palm Harbor also fits the shape model but is approximately
45 km², so it is deferred in favor of smaller places. Other candidates have holes
or disconnected components; none is reduced to its largest component.

The separately inspected [incorporated-place layer 4](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4)
returned all 25 records in the same query extent. Belleair Bluffs and Belleair Beach
are compact, county-contained, valid single-exterior municipal reference areas.
The packager explicitly distinguishes Census `G4210`/CDP/layer 5 from
`G4110`/incorporated-place/layer 4 and rejects unknown or conflicting classifications.
This adds reference-area metadata, with the same existing single-ring eligibility
model. A municipal reference area is not labeled a CDP or an HOA neighborhood.

| Order | Map | Census GEOID | Reference type |
| --- | --- | --- | --- |
| 1 | Bear Creek | 1204735 | CDP |
| 2 | Ridgecrest | 1260275 | CDP |
| 3 | Tierra Verde | 1271825 | CDP |
| 4 | Belleair Bluffs | 1205125 | Incorporated place |
| 5 | Belleair Beach | 1205100 | Incorporated place |

Source credits/terms remain separate for Census, County road centerlines and USGS
water. Minimal, checksum-pinned source packages in `geography/sources/{id}/` retain
original coordinates and rebuild offline; raw acquisition snapshots stay outside
`public/` and outside the repository. Normal map use loads WebP artwork.

## 1. Bear Creek

- Source: GEOID `1204735`, one valid 253-position core ring fully covered by
  Pinellas; 320 County roads and 33 USGS water records (30 Waterbody, 3 Area).
  Counts and source geometries reconcile; compact GeoJSON is 7,736,570 bytes.
  Raw snapshot is 62,423,409 bytes. Actual total request count is unrecorded;
  the successful helper path needs at least 13 requests, including two road pages.
- Rendering: four source road anchors, 18 labels; one new raster, 87 retained.
  Phone/narrow/landscape and picker passed visual review. Initial UX critique
  found center-only zoom did not show the northern street grid well. Verified a
  real WebKit pan after zoom and reset: street names become readable and reset
  restores the complete core. UX re-review and visual navigation review passed.
- Reflection: capture an actual street-inspection gesture for asymmetric areas,
  not only center zoom. Keep raw acquisition snapshots in cloud scratch and compact
  reusable packages in the repository; these are different artifacts. Wait for a
  complete package before rendering. Derive pagination from the helper's 200-ID
  cap rather than assuming the service's larger advertised limit.
- Next: apply the explicit snapshot/package contract and street-focused navigation
  review to Ridgecrest, without changing its source coverage.

## 2. Ridgecrest

- Source: GEOID `1260275`, one valid 159-position ring, fully covered by Pinellas;
  all 471 roads and 33 Waterbody features reconcile. Empty Area IDs are confirmed
  by an independent zero count. Snapshot 1,721,292 bytes; compact GeoJSON 255,239
  bytes. One acquisition invocation, 14 expected helper requests derived from
  its saved results/control flow (three road pages); no instrumented counter.
- Rendering: four source road anchors, 18 labels; one new raster, 88 retained.
  Visual review passed. UX requested inspection of a sharply rectangular pale
  southeast patch. A targeted pan/zoom plus exact source membership check showed
  its center outside coverage and 99.1% of the sampled patch outside the core.
  The fade follows a genuine boundary notch; 119th St N and Walsingham Rd context
  are retained. UX re-review passed without adding invented detail.
- Reflection: distinguish faded out-of-core context from missing geometry using
  the exact source polygon and screen transform before adjusting artwork. The
  explicit raw-snapshot/compact-package handoff avoids a duplicate acquisition;
  root packages once after source validation. Small record counts alone still
  do not predict geographic input size: this map's water is much smaller.
- Next: inspect Tierra Verde's coastal water complexity and navigation at zoom,
  retaining the full reference core and all source water components.

## 3. Tierra Verde

- Source: GEOID `1271825`, valid single 100-position exterior fully covered by
  Pinellas; all 313 roads (two pages) and 33 water records (28 Waterbody, 5 Area)
  reconcile. Water retains 1,457 rings and 175,420 positions, including all holes.
  Snapshot 57,101,592 bytes; compact GeoJSON 7,076,211 bytes. One invocation and 13
  expected helper requests derived from paging/control flow, not an API counter.
- Rendering: four source anchors, 11 street labels; one new raster, 89 retained.
  UX and visual reviews passed phone/narrow/landscape, zoom and picker states.
  Collany Rd, Pinellas Bayway S and Saints Point Dr are readable at zoom. The broad
  water fill and angular edges match the Census reference core, not a shoreline.
- Reflection: retain water components/holes and the full dated reference boundary;
  do not trim water to make the map look like an island silhouette. Compact JSON
  avoids transferring indentation, and normal browsing uses the raster. Record
  the nonblocking UX suggestion for a shared explanation that reference coverage
  can include water; existing metadata already distinguishes coverage from a
  surveyed shoreline. No extra source fetch or speculative geometry repair.
- Next: Belleair Bluffs tests the explicitly classified incorporated-place input
  using the same single-ring renderer and coverage model.

## 4. Belleair Bluffs

- Source: Census layer 4, GEOID `1205125`, `Belleair Bluffs city`, MTFCC `G4110`;
  explicitly an incorporated place. The valid 122-position exterior is fully
  covered by Pinellas. All 359 roads (two pages), two Waterbody features and one
  Area feature reconcile. Water retains 1,426 rings and 174,101 positions.
  Snapshot 56,619,611 bytes; compact GeoJSON 7,018,909 bytes; 13 expected helper calls
  derived from saved results, one invocation, no instrumented request counter.
- Rendering: four source anchors, 18 labels; one new raster, 90 retained.
  Phone/narrow/landscape, zoom and picker passed independent UX and visual reviews.
  The wide place shape leaves portrait context margins; it is neither stretched
  nor cropped. Sunset Dr, Pinehurst Ave and Sunset Blvd are legible at zoom.
- Reflection: source classification is an input contract. Require agreement of
  Census MTFCC, inspected metadata name and layer ID; emit incorporated-place
  identity/credits/coverage notes rather than silently labeling a municipality a
  CDP. The same renderer and single-ring eligibility work without a model change.
  Preserve the geographic aspect ratio instead of filling every screen with it.
- Next: Belleair Beach checks the opposite, long coastal footprint using the same
  incorporated-place validation and per-map review loop.

## 5. Belleair Beach

- Source: Census layer 4, GEOID `1205100`, `Belleair Beach city`, MTFCC `G4110`;
  valid single 57-position exterior fully covered by Pinellas. All 287 roads
  (two pages), one Waterbody and two Area features reconcile. Water retains all
  1,451 rings and 177,083 positions. Snapshot 57,461,545 bytes; compact GeoJSON
  7,109,331 bytes. One invocation, 13 expected helper calls from saved results.
- Rendering: four source anchors, 18 labels; one new raster, 91 retained.
  Both reviewers passed phone/narrow/landscape, zoom and picker states. Applying
  the Bear Creek lesson before review, controlled pan/zoom captures also show
  readable 23rd/18th/12th St and Belleair Beach Cswy along the narrow land strip.
  Reset restores the full reference area; no component is stretched or cropped.
- Reflection: capture a complete street-exploration and reset flow for asymmetric
  coastal areas. Pause the automated drag before release to inspect a controlled
  pan rather than an accidental inertial flick. Preserve the source water geometry
  instead of replacing it with a guessed shoreline. A shared renderer and isolated
  per-map acquisition/render/review keep existing rasters reusable; run the full
  regression and delivery checks once for the completed five-map batch.
- Outcome: all five candidates passed source, UX and visual review. The branch
  now has 94 accepted maps, including 92 geography-only bundles and the original
  two sample maps. South Highpoint remains an unregistered study.

## Batch validation and delivery

All 105 Node/local Worker/D1/R2 checks passed. The complete Chromium and
phone-WebKit suite passed 261 checks with five intentional project-specific
skips. The isolated real-service submission/private-upload/owner-approval journey
passed in both engines. Independent final code/data review verified all five raw
snapshots against the compact packages, source terms/privacy allowlists, exact
coverage projection, four road anchors each, client/server count 94 and current
provenance hashes. The largest optional public geography file is 7,736,570 bytes.
A final raster pass rendered zero and retained all 92 geography-only rasters;
no previously tracked artwork or raster changed. The two earlier Census maps
only refresh their renderer fingerprint after the classification support update.

The five maps ship together through the existing ordinary PR/check/auto-merge/
exact-main production workflow. This consolidates delivery overhead after the
individual critique loops. No release-sensitive path or database schema changes.
Physical iPhone gesture performance remains outside these automated checks.
