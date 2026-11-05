# Continuous Pinellas browsing prototype

Open `/prototypes/discovery-map/`. This is the next product experiment after the bounded two-map canvas, with a representative visitor journey: **St. Petersburg → zoom out to Pinellas → find another neighborhood → open a display and photos**. It uses one geographic camera and a consistent cream/sage/plum vector treatment. The existing application's entry point, illustrated maps, seasonal service, and bounded artwork experiment remain separate.

The previous probe could test two illustrations, limited street context, and pin interaction. Its minimum zoom and clipped geography prevented evaluating county discovery. This prototype removes that restriction with a county silhouette, regional roads, and viewport-loaded local road tiles. It tests continuous browsing without claiming that the original 94 illustrations can form a seamless quilt or that the architecture has passed physical-device acceptance.

## Visitor behavior

- Arrival starts in St. Petersburg, near the published Old Northeast/Crescent Lake records. The map fills the viewport. No region or neighborhood list sits below it.
- Pinch, wheel, keyboard plus/minus, and zoom buttons change the same map. City names orient the county view; neighborhood references and display points become useful as the visitor approaches. A compact button or **All Pinellas** in search returns to a closer county overview. The zoom-out floor keeps the county substantial: 10.25 normally, 9.75 on viewports shorter than 480 px. Panning can reveal its northern and southern ends; a full-county fit is no longer required.
- Search matches all 94 prepared maps and city aliases, including St Pete. Exact city aliases rank before partial neighborhood matches such as St. Pete Heights. Results move the camera directly; they do not introduce a regional page.
- Selecting a neighborhood only moves the camera and loads nearby displays. There is no neighborhood detail pane. Neighborhood references and the overview caption disappear at zoom 14.5 and closer, when street names begin to appear, leaving streets and display targets. Neighborhood names remain available in search and in a selected display's metadata.
- Neighborhood diamonds and badges count prepared neighborhood maps, never displays. Their center references and camera extents come from the retained atlas/map projections. The extents are image frames, not official boundaries, eligibility masks, or administrative claims. Some secondary labels are omitted to keep targets clear; all prepared maps remain searchable.
- Published displays use plum circles. Nearby displays group by screen distance; at closest zoom, coincident records have an explicit chooser. Selecting a record identifies its actual coordinate, reveals it around the measured UI/card rectangles, and opens title/address, tags, description, approved gallery, directions, share, and a link to its existing illustrated neighborhood view. Closing preserves the camera.
- The original illustration is available through that existing view. No original-art overlays, clipping, warping, or seasonal decorations are introduced in this county canvas.
- Location is requested only by an explicit button tap. Denial or a point outside the county leaves exploration available. There is no location watch, geocoding service, or location submission.

## Public data and uncertainty

Default season is **past Halloween 2026**, using the existing published migration records; it is labeled as past. Map context provides the existing Christmas 2026 alternative. The prototype neither fabricates listings nor treats sample art/content as live seasonal listings.

The existing public API accepts one neighborhood/season per request. At zoom 13 and closer, the client checks up to 18 intersecting prepared-map frames, with four requests at a time, caching results by neighborhood and season. A selected neighborhood is prioritized. County overview requests no new listing feeds. Display totals always describe records loaded in the viewport, not all county listings; map context discloses checked, pending, failed, and capped coverage. A failed or malformed feed stays unavailable and retryable rather than becoming an empty list. Distinct IDs at one address remain distinct. Season changes clear selection and cannot display the other season's cached records.

Only selected-house photos reach the shared gallery, through approved same-origin `/api/photos/:id` public paths. Pending/admin/external photo URLs are excluded. No submission, moderation, importer, private export, database, or service write is part of this prototype. Photo/report/contribution actions continue to live in the existing neighborhood application.

## Camera and browser history

Camera changes replace the current URL's `lat`, `lng`, and `z`. Explicit search, city, county, and neighborhood moves create entries. Opening a display adds a selection entry; replacing an open selection replaces it. Dismissal removes selection with a replace and preserves the current camera. Back restores the prior explicit destination/selection. Shared links retain season, neighborhood, canonical listing ID, and camera. A pending deep-link lookup is cancelled by subsequent navigation so it cannot reopen an obsolete record.

## Geography preparation

`scripts/build-discovery-places.mjs` regenerates the catalog from the retained atlas and map projections. It carries canonical IDs and display extents without adding inferred neighborhood polygons.

`scripts/build-discovery-context.py` builds renderer-neutral GeoJSON from hashed public source snapshots outside `public/`. `--refresh-source` reacquires county GIS; the default rebuild validates retained source snapshots. Public source URLs, safe fields, timestamps, methods, source constraints, and derivative hashes are preserved in `data/source-notices.json`. It includes:

- The existing Census 2024 generalized Pinellas land outline (FIPS 12103).
- 10,519 county-envelope regional road features, generalized at 0.0001 degrees.
- 48,927 other source road features in 72 loading cells, generalized at 0.00003 degrees. At zoom 13.25 and closer, visible local cells load with three requests at a time; at most 12 completed nonvisible cells are retained where possible. Repeated paths at cell edges are deduplicated by source identity. Railroads are excluded from road rendering; trails are differentiated. Source road classes do not establish public access or routes.
- 21 retained USGS water features around the original St. Petersburg study. Inland water coverage is **not countywide**; the generalized coastline comes from Census. No full hydrology coverage is claimed.

Main context is about 2.57 MB raw / 258 KB gzip. All local tiles total about 12.19 MB raw / 1.26 MB gzip, loaded selectively. These are reference geometry and transfer estimates, not measured physical-iPhone memory or performance. Census is public domain; USGS is open/non-proprietary with acknowledgment; the county source does not declare a general open license. Existing artwork rights remain unchanged. Preserve each source's own terms for reuse.

## Review and acceptance

Cloud checks cover the zoom-out floor and reaching the county's ends by panning, direct neighborhood navigation without a pane, street-level label removal, search ranking, feed errors/recovery, season isolation, selected-point visibility, coincident records, approved photos, stale deep-link cancellation, and history. Source tests verify manifest hashes and the unique regional/local partition. Independent UX and visual agents inspect real public-data renders at 390×650, 320×568, 667×375, and 1280×900 before delivery; fixes and review evidence are retained in the cloud design-review folder.

This is a candidate for evaluating the browsing direction. Physical iPhone pan/pinch, browser chrome, VoiceOver, and memory/GPU acceptance remain unverified. The artwork registration gate from the bounded study is still unpassed. Search/zoom correctness and clean renders do not establish faster display discovery; comparative visitor tasks remain necessary. This prototype does not replace the main visitor entry point or establish production-scale county listing aggregation.
