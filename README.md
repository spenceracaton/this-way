# This Way map prototype

One isolated Old Northeast map, using reused illustrated geography and Leaflet 1.9.4. This is a local candidate for the Christmas successor, not a deployment or a replacement for Fright This Way.

## Run

Requires Node.js 20 or later. No dependency installation, account, API key, build, or network connection is required to run it after downloading.

```sh
npm run dev
```

Open `http://localhost:5173/`. For the same app in a 390px-wide frame, open `http://localhost:5173/narrow.html`. Stop with Ctrl+C.

```sh
npm run check
```

This runs the eight coordinate, asset-preservation, invalid-input, and dependency-integrity checks using Node's built-in test runner.

## Browser checks (PR 2)

The app and eight Node checks still need no installation. The browser suite uses
exactly pinned Playwright 1.64.1 development dependencies and a committed lockfile:

```sh
npm ci
npx playwright install --with-deps chromium webkit
npm run check
npm run test:browser
```

Playwright starts and stops the included server on port 5173. Stop any manually
started server on that port first. It runs five scenarios in desktop Chromium
(1280×900) and phone-sized WebKit (390×664, iPhone 13 device profile). All ten
browser cases run on each PR in one GitHub Actions job, after the eight Node
checks. There are no retries, path classifiers, deployment credentials or
publishing steps. Superseded check runs are cancelled.

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
- Four reference pins preserve the original affine geographic projection and align with independently retained road anchors. Measured desktop rendering error was below one screen pixel at the initial view.
- Desktop Chromium browser checks exercised mouse selection, zoom, drag panning, native keyboard panning, reset, Enter selection, and Escape clearing.
- A narrow iframe using the same app showed four pins, selection, zoom/reset controls, and no horizontal page overflow. Its 390px frame had 375px of content width after the browser scrollbar.
- The neutral SVG retains the geographic paths and two original masks. The core mask path is fingerprint-checked against the inspected source. The rendered coastal reference was visually inspected.

The prototype does not establish physical-iPhone touch/scroll performance, every neighborhood's compatibility, deployment correctness, production asset loading, or rollback. Those remain later acceptance checks.

## Why Leaflet was selected

The inspected renderer's camera updates directly call detail-card layout, cluster logic, location rendering, dynamic street labels, neighborhood edges, and invitations. Extracting it would require deciding which of those application behaviors to carry over or replace.

The artwork already uses a fixed SVG coordinate system, and `lib/neighborhoods.mjs` defines an explicit affine longitude/latitude conversion. Leaflet's `CRS.Simple` and SVG overlay accept this without a map service or token. This was enough evidence to build one candidate; a second competing application was unnecessary.

This is a promising fit for one map. It is not a claim that Leaflet will require no additional adaptation for future neighborhoods or richer interaction.

## Code boundaries

| File | Responsibility |
| --- | --- |
| `public/coordinates.mjs` | Pure coordinate conversion and SVG-to-map axis orientation |
| `public/map-view.mjs` | Leaflet setup, artwork, markers, selection callbacks, reset and resize |
| `public/app.mjs` | Load local files and connect the map to the small reference interface |
| `public/sample-pins.mjs` | Four public road reference points and independent expected anchors |
| `public/assets/old-northeast.svg` | Editable neutral artwork, including the core and nearby masks |
| `public/data/neighborhood.json` | This map's bounds, projection and original illustrative boundary |
| `public/data/geography.json` | Attributed original road geometry used to verify reference coordinates |
| `public/data/provenance.json` | Inspected source commit, file fingerprints, transformation notes and dependency integrity |
| `public/vendor/leaflet/` | Pinned runtime JS/CSS and upstream license |
| `scripts/serve.mjs` | Static-file development server only |
| `tests/map.test.mjs` | Source-coordinate, mask and integrity checks |

No application backend, accounts, database, uploads, simulated storage, submission flow, events, hearts, or rankings were imported. The map receives its data and reports selection; it does not fetch records or manage a detail-card application.

## Reused artwork and seasonal separation

Inspected source commit: `73338cbae5d85cc1e4751ee7fe00a5a1b6ae9fb3`, retrieved through the official Sites source access on October 29, 2026. The original checkout was left unchanged.

The source's Halloween content is separable: ghost/pumpkin symbol definitions and the runtime's injected seasonal decoration groups. The prototype omits those, empty decoration groups, the existing house art, and application layers. It preserves road/land/water geometry, street labels, projection, the core mask and nearby-area mask.

The prototype uses unblurred vector masks and omits paper/water texture across devices. That is a deliberate simplified appearance for evaluation, not exact desktop visual parity or proof of improved device performance. The old iOS-specific effect-switching script was not copied.

SVG coordinates increase downward; Leaflet's simple-map y axis increases upward. The adapter maps an artwork point `(x, y)` to `[-y, x]`. It does not substitute Web Mercator or treat artwork pixels as real latitude/longitude. An illustrated boundary is not a verified legal membership boundary.

The four pins are public road vertices, not decorated properties or claims of Christmas participation. Original OSM geometry and independent artwork anchors supply the reference checks.

## Next acceptance step

Cloudflare configuration and the manual GitHub release/rollback workflow are
documented in [DEPLOYMENT.md](DEPLOYMENT.md). Delivery acceptance remains pending
until the production credential is configured and real deployment/rollback
evidence is recorded. PR checks now validate and browser-test the packaged assets.

Review this map approach and check it on a physical iPhone. Source is now in the private `spenceracaton/this-way` GitHub repository. Then connect a user-owned Cloudflare account, deploy the same static files, verify asset paths, and demonstrate application rollback. Do this before adding feature layers. There is no new Sites project, source synchronization, publishing controller, or hosting migration in this package.

The product decisions about free-text description, optional real theme, and curated seasonal tags remain future application work. They do not require changes to this map renderer.

## Third-party material

- Leaflet 1.9.4, BSD-2-Clause; full license in `public/vendor/leaflet/LICENSE`. The JS/CSS bytes match the integrity hashes published at <https://leafletjs.com/download.html>. The JS came from the cdnjs GitHub distribution and the CSS/license from the tagged upstream Leaflet repository.
- Geography: © OpenStreetMap contributors, originally retrieved October 13, 2026; attribution remains visible. Source: <https://www.openstreetmap.org/copyright>; database license: <https://opendatacommons.org/licenses/odbl/1-0/>. The reused illustrated asset is derived from that attributed geography and Fright This Way's existing artwork.

There are no runtime CDN requests or external map tiles. The library and artwork are included with the source.
