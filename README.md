# This Way map prototype

94 prepared neighborhood maps using reused illustrated geography and Leaflet 1.9.4. Old Northeast and Crescent Lake retain their sample addresses; the other 92 maps contain geography only. The public map bundles contain no seasonal overlays or imported FTW listing records.

The catalog combines the original 59-map import with 16 additional maps recovered from pinned retained source directories in Fright This Way QA revision `00ba22299bdedd5bd7e3c2548b90e4e7e74d86d8`. Three more maps—Mystic Lake, Stonesthrow, and Holiday Park—come from a complete audit of the pinned source cohorts. Those directories are historical inputs, not the current production source authority. The final nine-map batch completes all 12 recovered bundles, for 87 FTW-derived maps total. Seven independently prepared county/Census maps—Greenbriar, Harbor Bluffs, Bear Creek, Ridgecrest, Tierra Verde, Belleair Bluffs, and Belleair Beach—bring the catalog to 94. Their January 1, 2026 Census reference boundaries, County roads and USGS water are retained as reusable geographic inputs. The first five use CDP areas; Belleair Bluffs and Belleair Beach use explicitly classified incorporated-place areas. South Highpoint remains an unregistered multipart/holed source study. This is not a claim of complete current FTW coverage: 34 directory-only entries lack a verified reusable map definition. Coverage shading represents approximate app coverage, not legal neighborhood boundaries or a surveyed shoreline. OSM, City GIS, County/Esri, and USGS source credits are retained where applicable. Feather Sound uses County road centerlines and USGS water data with its declared mixed-source terms; it is not labeled OSM.

Only the selected map's configuration and artwork load. Imported lossless WebP images have a maximum 3072px long edge; their SVG sources remain available for diagnostics. The browser does not download the entire catalog's artwork.

Each map is a separate data/artwork bundle. See [map reuse and coordinate format](docs/map-data.md) for using it outside this application, and [the expansion audit](docs/neighborhood-expansion.md) for recovered and pending areas. Artwork retains its permission-based license; technical portability does not grant reuse rights.

The same-origin Worker adds durable listings in D1 and private photo storage in
R2. Valid text/address submissions publish immediately; photos wait separately
for authenticated owner review. See [service setup](docs/service-setup.md),
[API contracts](docs/service-api.md), and [FTW migration planning](docs/ftw-migration.md).
Production activation was verified at commit `4ac4a28ea30b5227af250f96615102d2a167b374`
in [run 41570806085, attempt 4](https://github.com/spenceracaton/this-way/actions/runs/41570806085).
Public API, owner sign-in/moderation access, and logout passed live checks.
Production FTW records have not been migrated. An [isolated public-data rehearsal](docs/ftw-rehearsal-pilot.md) inspected 40 real listings, imported 31 eligible records and five photos into local storage, and verified a no-op rerun and persistence. Nine placements remain flagged; the rehearsal data and photos are private cloud artifacts, not public site assets.

The next [guarded checkpoint and restore preparation](docs/ftw-checkpoint-recovery.md) supports reviewed source updates and recovery in isolated storage. Live migration still requires an [authorized content export](docs/ftw-source-export.md) and a reviewed operator connection; these tools expose no public import endpoint.

## Rebuild the imported geography

The committed assets run without QA-repository access or Python. Rebuilding the FTW-derived bundles requires existing read access to the private QA repository through `gh`, Python with Pillow, and Playwright Chromium:

```sh
python3 scripts/fetch-ftw-geography.py --output /tmp/this-way-ftw-geography
python3 scripts/import-ftw-geography.py --source /tmp/this-way-ftw-geography/source --reference /tmp/this-way-ftw-geography/reference
python3 scripts/fetch-ftw-geography.py --expansion --output /tmp/this-way-ftw-expansion
python3 scripts/import-ftw-geography.py --source /tmp/this-way-ftw-expansion/source --reference /tmp/this-way-ftw-expansion/reference
python3 scripts/fetch-ftw-geography.py --plan scripts/ftw-ready-geography-sources.json --output /tmp/this-way-ftw-ready
python3 scripts/import-ftw-geography.py --source /tmp/this-way-ftw-ready/source --reference /tmp/this-way-ftw-ready/reference
node scripts/rasterize-neighborhoods.mjs
node scripts/build-service-geography.mjs
```

County/Census maps rebuild from committed source packages without private QA access:

```sh
for source in geography/sources/*/; do
  python3 scripts/build-county-map.py --source "$source" --output-root . || exit
done
node scripts/rasterize-neighborhoods.mjs
node scripts/build-service-geography.mjs
```

See [the county preparation log](docs/county-map-preparation.md) and
[the five-map follow-on review](docs/county-five-map-review.md) for source acquisition,
per-neighborhood critique, and the South Highpoint geometry stop.

Set `CHROMIUM_EXECUTABLE_PATH` when using an existing Chromium installation. The fetcher verifies Git blob hashes; the original expansion plan also checks maintained QA fixture fingerprints where available. The ready-geography plan checks recorded source asset and metadata fingerprints; these do not imply additional maintained fixture coverage. Each map records source checksums, preserved mask geometry, four independently matched road anchors, and raster checksums in its provenance. Valid raster outputs are reused when their source and dimensions are unchanged. The importer deliberately excludes listing data, executable SVG, external resources, textures, and seasonal decorations. Use `--ids id-a id-b` to select a batch and `--output-root /tmp/map-preflight` to validate in a scratch output tree. A failing source/metadata preflight writes no batch outputs.

## Run

Requires Node.js 22 or later. No dependency installation, account, API key, build, or network connection is required to run it after downloading.

```sh
npm run dev
```

Open `http://localhost:5173/`. For the same app in a 390px-wide frame, open `http://localhost:5173/narrow.html`. Stop with Ctrl+C.

```sh
npm run check
```

This runs coordinate, asset-preservation, invalid-input, catalog-integrity, release, and gate checks using Node's built-in test runner.
It also runs real local Worker/D1/R2 integration checks for persistence, private
photos, authentication, moderation, concurrent upload limits, and retries. Python
is needed for the importer's generated-fixture regression tests.

For a complete browser journey with a real isolated Worker, database, and bucket:

```sh
npm run test:service
```

This command creates temporary local state and test credentials, exercises both
browser engines, and removes the state afterward. It does not contact production
databases or upload to a remote bucket. `-- --project=phone-webkit` selects one
browser. For an interactive persistent local service, use the setup guide's
local Worker instructions.

## Browser checks (PR 2)

The app and Node checks still need no installation. The browser suite uses
exactly pinned Playwright 1.64.1 development dependencies and a committed lockfile:

```sh
npm ci
npx playwright install --with-deps chromium webkit
npm run check
npm run test:browser
```

Playwright starts and stops the included server on port 5173. Stop any manually
started server on that port first. Desktop Chromium (1280×900) and phone-sized
WebKit (390×664, iPhone 13 device profile) exercise map, detail, picker, and form
behavior, every supported neighborhood route, and representative SVG diagnostics.
CI runs the Node checks, prepares and verifies a frozen release artifact, then
tests that artifact in both browser engines. Superseded runs are cancelled.

The scenarios cover independent rendered pin anchors, actual browser rasterization
of the shoreline/nearby masks, pointer and keyboard selection, pan/zoom/reset/Home,
and viewport fit. The mask samples include core land, the nearby ring, water, and
outside both masks. Expected anchors are fixed in the test and never computed by
the application's projection. A map screenshot is attached for visual review;
failures retain a screenshot and trace. The HTML report and results are uploaded
for seven days, including successful map screenshots.

Phone WebKit checks include a real tap on a pin, but drag panning in this suite
uses pointer events. Device emulation does not establish physical-iPhone Safari
performance, touch gesture behavior, deployment, or compatibility of a second map.

## What this proves so far

- A standard map engine can display this neighborhood's illustrated SVG and its original core/nearby masks.
- The two original maps each have four numbered address samples aligned with independently recorded public map markers. The other maps contain geography without invented listings. OSM road anchors remain separate geometry fixtures.
- Desktop Chromium browser checks exercised mouse selection, zoom, drag panning, native keyboard panning, reset, Enter selection, and Escape clearing.
- A narrow iframe using the same app showed four pins, selection, zoom/reset controls, and no horizontal page overflow. Its 390px frame had 375px of content width after the browser scrollbar.
- The neutral SVG retains the geographic paths and two original masks. The core mask path is fingerprint-checked against the inspected source. The rendered coastal reference was visually inspected.

Local checks establish geometry and automated UI behavior. Each production release
is verified separately against its exact `main` commit. Physical-iPhone gesture
performance and a real rollback exercise remain separate acceptance checks; the
new listing service also requires its documented owner setup before activation.

## Why Leaflet was selected

The inspected renderer's camera updates directly call detail-card layout, cluster logic, location rendering, dynamic street labels, neighborhood edges, and invitations. Extracting it would require deciding which of those application behaviors to carry over or replace.

The artwork already uses a fixed SVG coordinate system, and `lib/neighborhoods.mjs` defines an explicit affine longitude/latitude conversion. Leaflet's `CRS.Simple` and SVG overlay accept this without a map service or token. This was enough evidence to build one candidate; a second competing application was unnecessary.

The same adapter now renders all 94 prepared maps. Additional geography and richer interactions still require their own source and browser checks.

## Code boundaries

| File | Responsibility |
| --- | --- |
| `public/coordinates.mjs` | Pure coordinate conversion and SVG-to-map axis orientation |
| `public/map-view.mjs` | Leaflet setup, artwork, markers, selection callbacks, reset and resize |
| `public/app.mjs` | Load local files and connect the map to the small reference interface |
| `public/sample-pins.mjs` | Four public Old Northeast address samples and independent expected anchors |
| `public/assets/old-northeast.svg` | Editable neutral artwork, including the core and nearby masks |
| `public/data/neighborhood.json` | This map's bounds, projection and original illustrative boundary |
| `public/data/geography.json` | Attributed original road geometry used to verify reference coordinates |
| `public/data/provenance.json` | Inspected source commit, file fingerprints, transformation notes and dependency integrity |
| `public/vendor/leaflet/` | Pinned runtime JS/CSS and upstream license |
| `scripts/serve.mjs` | Static-file development server only |
| `tests/map.test.mjs` | Source-coordinate, mask and integrity checks |

The static development server remains an illustrative preview. When the listing
service is configured, the default map uses live records and approved photos;
the original samples remain available only through explicit `?sample=a`, `c`, or
`d` links. An enabled service error is shown to the user rather than replaced
with fictional records. Public listing DTOs omit object keys, private source
snapshots, upload capabilities, and review notes.

## Core component previews

The header's **Add a display** button collects an address, a confirmed map pin,
optional theme/description, photos, and season-configured tags. In service mode,
the text listing is saved and appears immediately. Up to three JPEG/PNG/WebP
photos are resized in the browser, validated and stripped of metadata on the
server, and stored privately pending review. An upload failure keeps the saved
listing and offers a photo retry. **Add photos** on a live listing uses the same
private review flow. **Report** and **Feedback** remain clearly labeled previews.
On the static development server, submission/photo forms also remain previews.

`review.html` uses a single-owner sign-in when the service is enabled. Photo
approval/rejection is independent of text listing visibility; the owner can also
hide or restore a text listing. Private images require the owner session. Review
decisions use record versions to catch stale actions and write transactional
audit events. In static mode the page retains the fictional **Review demo**;
those decisions stay in memory and reset on reload.

The components live in separate ES modules (`submission.mjs`, `community-forms.mjs`, `photo-contribution.mjs`, and `review.mjs`/`review-data.mjs`) with scoped styles. `dialog.mjs` shares native-dialog dismissal, focus return, scroll locking, and overflow cues. UI references came from the Fright This Way QA repository; no FTW submission endpoints or private production data were copied.

## Reused artwork and seasonal separation

Inspected source commit: `73338cbae5d85cc1e4751ee7fe00a5a1b6ae9fb3`, retrieved through the official Sites source access on October 29, 2026. The original checkout was left unchanged.

The source's Halloween content is separable: ghost/pumpkin symbol definitions and the runtime's injected seasonal decoration groups. The prototype omits those, empty decoration groups, the existing house art, and application layers. It preserves road/land/water geometry, street labels, projection, the core mask and nearby-area mask.

The prototype uses unblurred vector masks and omits paper/water texture across devices. That is a deliberate simplified appearance for evaluation, not exact desktop visual parity or proof of improved device performance. The old iOS-specific effect-switching script was not copied.

SVG coordinates increase downward; Leaflet's simple-map y axis increases upward. The adapter maps an artwork point `(x, y)` to `[-y, x]`. It does not substitute Web Mercator or treat artwork pixels as real latitude/longitude. An illustrated boundary is not a verified legal membership boundary.

The eight sample pins use publicly displayed 2026 Fright This Way street addresses and map marker coordinates, checked November 2, 2026. They are location references, not claims of Christmas participation. Display titles and photos in this prototype are illustrative. The map and cards label these as samples. Original OSM road vertices remain independent geography fixtures in the Node tests; public marker positions supply the address alignment checks.

## Next acceptance step

Cloudflare delivery and the GitHub release/rollback workflow are documented in
[DEPLOYMENT.md](DEPLOYMENT.md). Normal delivery validates a frozen release,
runs both browser engines, deploys current `main`, and checks the hosted release.
Physical iPhone gestures and a real rollback exercise remain separate acceptance
checks; browser emulation and map-source tests do not establish those outcomes.

Address placement currently uses a manual pin and explicit address-match
confirmation. County address lookup/geocoding remains future work. The FTW import
planner preserves legacy coordinate provenance and flags unresolved locations
before a published listing can be planned; it does not guess a projection or run
an actual import. Events and resident self-service remain out of scope.

## Third-party material

- Leaflet 1.9.4, BSD-2-Clause; full license in `public/vendor/leaflet/LICENSE`. The JS/CSS bytes match the integrity hashes published at <https://leafletjs.com/download.html>. The JS came from the cdnjs GitHub distribution and the CSS/license from the tagged upstream Leaflet repository.
- Geography: © OpenStreetMap contributors, originally retrieved October 13, 2026; attribution remains visible. Source: <https://www.openstreetmap.org/copyright>; database license: <https://opendatacommons.org/licenses/odbl/1-0/>. The reused illustrated asset is derived from that attributed geography and Fright This Way's existing artwork.

There are no runtime CDN requests or external map tiles. The library and artwork are included with the source.
