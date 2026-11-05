# Regional overview handoff

Status: design and implementation handoff. No regional overview feature has been shipped or validated by this document. Reference mock shapes, positions, and numbers are illustrative.

## Outcome

Make the generic This Way entry point a map-first Pinellas overview. Visitors can orient across the county, zoom to distinguish nearby neighborhoods, open a prepared neighborhood map directly, and return to the same overview camera. A searchable picker is an equivalent route. Seasonal projects supply their own title, language, items, markers, filters, theme, and actions; the regional geography and navigation do not know about Halloween or Christmas.

The first useful prototype uses Old Northeast, Crescent Lake, and Historic Kenwood if their city boundary identities and locators validate. It remains isolated from the main entry point until reviewed.

## Current repository, checked November 4, 2026

Base reviewed: `e34055c7b42e4189631dc4228508463877b33d8d`.

- `public/prototypes/pinellas-atlas/` is an existing county sketch, not the target interaction. It starts at four conceptual browse regions, gives each place a preview panel, then opens the detail map in a new tab. Its counts and links are fixed to Halloween 2026. Its markers show individual names only on focus/selection, while the requested closer view needs readable names and counts.
- `atlas-data.json` contains a sourced, generalized 2024 Census county outline and catalog locators, but no actual neighborhood polygons. Its centers come from prepared map coverage centroids. The regions and colored washes are conceptual, not neighborhood geography. See its `provenance.md`.
- `public/neighborhoods.mjs`, `public/neighborhood-catalog.mjs`, and `public/neighborhood-picker.mjs` expose the prepared map IDs, names, routes, and searchable compact picker. Reuse their identities and picker behavior. The picker currently describes sample addresses or “Map only”; count text must come from the chosen experience.
- `public/app.mjs` loads only the selected neighborhood configuration and raster artwork. `public/map-view.mjs` keeps Leaflet zoom animation disabled to allow immediate pan after pinch. Preserve that path and the existing item selection and filter behavior in the detail view.
- `GET /api/listings?neighborhood=ID&season=ID` returns public published listings with approved photos. There is no regional count endpoint today. `GET /api/config` distinguishes a missing demo service from an enabled service error. Do not silently replace an API failure with sample or zero counts. See `docs/service-api.md`.
- Existing `coreBoundary` and Crescent Lake `serviceCoverage` describe approximate **app coverage**. They are not verified neighborhood association boundaries. Do not draw them as the requested neighborhood outlines. Existing city/CDP packages also have differing reference-area meanings. Keep each source and its uncertainty explicit.

Check the hosted version and assets again immediately before implementation. The repository can change independently of this handoff.

## Geometry and data

The City of St. Petersburg publishes a queryable [Neighborhood Associations layer](https://egis.stpete.org/arcgis/rest/services/ServicesDOTS/NeighborhoodRelations/MapServer/22) (polygon layer 22, display field `NANAME`, status field `STATUS`). Its [metadata](https://www.arcgis.com/sharing/rest/content/items/4fba3c14cdd64a328337ef6db641bb10/info/metadata/metadata.xml?format=default&output=html) says the dataset covers city neighborhood associations, is updated as needed, and carries an accuracy disclaimer. CONA also [points residents to the city GIS map](https://www.stpetecona.org/neighborhoods) for boundaries. This is the first candidate source for the three-place pilot, not a completed identity or geometry verification.

For each pilot neighborhood:

1. Query the city layer by exact association name; record the returned `OBJECTID`, `NANAME`, `STATUS`, retrieval date, source URL and response checksum. Inspect whether the result is one feature, whether multipart rings/holes survive coordinate conversion, and whether its name denotes the intended neighborhood. Compare with CONA or the association when ambiguous. Do not assume the Historic Kenwood *historic district* is the same area as its neighborhood association.
2. Save a small WGS84 GeoJSON or equivalent geometry layer, keeping every component, hole, and real overlap. Simplify only for display after checking shape and topology against the source. If a feature is missing or genuinely disputed, show a locator without an outline and document that state.
3. Verify a locator within the relevant feature where possible. An artwork-derived coverage centroid is only a candidate. Record the source and reason for the final point.
4. Keep each area’s stable app ID, display name, verified locator, direct destination, availability, geometry/source metadata, and current experience count separate. Geometry cannot determine listing membership.

Suggested minimal contract, not a general wrapper framework:

```js
{
  id: 'old-northeast',
  name: 'Old Northeast',
  locator: null, // populate with a verified { lat, lng }
  href: '/?neighborhood=old-northeast',
  available: true,
  geometry: null, // populate with a sourced Polygon/MultiPolygon
  source: { label: 'City neighborhood association', url: '…', retrievedAt: '…', featureId: '…', note: '…' }
}
```

One small pilot data file can hold the three records; avoid configuration machinery until another use demands it.

An experience supplies `seasonId`, item terminology, public item data, marker presentation, filters, copy, theme, and actions. Count distinct **public** item IDs per neighborhood for that experience and season. A regional total uses a set of stable IDs across all memberships. Preserve an item’s legitimate multiple neighborhood assignments. If the service only exposes per-neighborhood lists, the pilot may request three lists and deduplicate by ID; a broader overview should use a bounded server aggregate rather than 94 requests. Show “Count unavailable” when a real service fails, and label sample counts as samples. Do not show the mock’s 42/21/13 as data.

## Overview interaction

- Start at a useful St. Petersburg extent if the pilot items support it. The county extent stays available through zoom out or a fit control. A city is a camera extent, not a required intermediate page.
- Use a light basemap: cream/sage land, lavender water, fine linework, consistent low-contrast polygon fill/outline. No choropleth, darkening by count, stitched detail artwork, heavy masks, blur, or large moving raster effects.
- Draw outlines independently from labels. At wider scales, cluster labels whose full tappable boxes collide; activating a cluster zooms toward its member locators. Recalculate collision after zoom, pan and resize. At closer scales show a neighborhood name and its count in a fixed readable type size. Do not shrink long names. Keep targets at least 44 CSS px and non-overlapping; a full neighborhood name remains discoverable in the picker when the map is crowded.
- Activating a neighborhood label or picker row opens its detailed map immediately. Store the overview center and zoom in history/session state scoped to that navigation, then show “Back to overview” in the detail view. Browser Back should also behave sensibly. Restore the exact camera and let reduced-motion preferences suppress any transition.
- Keep the existing detail-map interactions, item selection and applicable filters. Load its artwork on entry, not during overview motion.
- The existing curved compact picker and shared cream/plum controls are the visual reference. The generated mock is a composition guide, not a production basemap or geography source.

## Prototype acceptance

1. A desktop visitor can zoom/pan, separate a cluster, activate each of the three neighborhoods directly, return to the same center/zoom, and reach all three by search.
2. At 390×664 and a narrower phone-sized WebKit viewport, names/counts and 44px targets remain readable and do not collide. Mouse/keyboard controls and search work without pinch. Focus, accessible names, status messages, and reduced motion are checked.
3. Public counts exclude hidden/unapproved content, distinguish an unavailable API from zero, and deduplicate a stable item ID in the regional total without changing membership.
4. The existing detail-map selection and raster/vector fast path still work. Run Node checks and the desktop Chromium/phone WebKit browser suite against the changed prototype. Then use a physical iPhone to pinch and pan immediately, drag, reset, rotate, and assess smoothness before claiming it.
5. Ask a few local users to find their neighborhood without coaching; record where they expected to tap and whether the picker helped. This is a usability check, not a release gate invented by code.

## Decision points before expansion

Confirm the city layer’s exact identities and geometry for the pilot; decide which season/experience supplies real public counts (or mark them sample); inspect current hosted shell and map styling; and validate the three-way navigation on devices. Then extend the catalog with individually sourced boundaries. Missing polygons are honest omissions, not an invitation to trace the mock or derive boundaries from item clusters.
