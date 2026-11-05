# Shared geographic canvas: bounded experiment

Open `/prototypes/continuous-map/` (or `index.html` with the basic static server). This is the bounded geometry/context/pin probe from the continuous-navigation discussion. It now starts with a coherent street map; the original two-art quilt is an explicit comparison at `?art=both`. It is separate from the existing local maps and the regional-overview handoff. The application's entry point has not changed. Search, clustering, the full detail/gallery experience and custom navigation history are deliberately deferred until this canvas is convincing on a physical phone.

## What can be inspected

- A single north-up Leaflet geographic camera. Arrival requests no artwork images. Named **Old Northeast art** and **Crescent Lake art** controls reveal an individual original-art layer using the inverse of its retained drawing projection, without moving the camera or filtering the records. Their hard image edges remain visible and are signposted as original-art overlays.
- Bounded neutral road/water context, including an unillustrated area. The land rectangle and gray exterior identify the study's coverage, not an official neighborhood boundary or zero-listing region.
- Only two public listing feeds for one selected season, defaulting to `halloween-2026`; `?season=christmas-2026` uses that real public season instead. Counts mean unique published record IDs across those feeds. Distinct IDs at the same address are not merged. Service failure is explicit and retryable, never a sample fallback or invented zero.
- Accurate small display points at overview scale, numbered faces at closer zoom and a prominent selected record. The artwork switch never moves the geographic pin layer. An on-demand coordinate list makes every loaded record reachable, including overlapping markers. No display clusters or invented fixtures appear in the public study.
- **Map tools** explicitly resets the starting camera, frames both neighborhoods or visits nearby streets. It also exposes the original overlap comparison and full/source-spotlight treatments. The close/header stays reachable while the tools scroll. Only the active art version is attached; cancelled loads are discarded. Images are capped at 2,048 pixels on their long edge. A layer choice replaces its URL query without adding a Back step; `?art=both` restores the original comparison on reload.
- A minimal address identifier and season/neighborhood label. Its marker is revealed around measured control/card rectangles, including after rotation. Closing it retains the camera. A successful feed retry resolves the selection against the new record by ID, so its address and coordinates cannot remain stale. The existing-map link preserves the season and focused/selected neighborhood, plus the selected canonical record ID.
- Base street names remain visible in transparent image margins: label ownership samples the loaded alpha footprint instead of suppressing a whole image rectangle. Candidate label widths and control/card/pin collisions are checked; the road-name index is prepared once. No new neighborhood boundary or eligibility geometry is inferred from art.

Arrow keys pan the focused map; plus/minus zoom; Home returns to the crossing. Native dialog focus and explicit buttons provide non-gesture controls. The study makes no geolocation request or service write.

## Current findings and limits

The first actual rendered crossing exposes a substantial mismatch in baked label size, street stroke and art/base treatment. Old Northeast's labels occupy a larger geographic scale than Crescent Lake's. Source spotlight cutouts reduce the full rectangular coverage but do not establish a clean join or pixel ownership. These are evidence against an untouched-art quilt being ready, not proof that continuous navigation itself fails.

The code does not deform either source artwork, invent a boundary mask, alter listing coordinates or claim the seam is solved. Per-art/base modes preserve the comparison. A next rendering candidate could focus one illustration while retaining the geographic camera; a deliberate local-map transition or lighter illustration would be a separately evaluated design decision.

Two derivatives together estimate 28,573,696 bytes (27.25 MiB) of RGBA buffers, versus 117,125,440 bytes for the original pair. This excludes browser/GPU copies and does not measure peak Safari memory. The bounded context package is about 437 KB: 1,765 county road features and 21 USGS water features, clipped to the declared bbox and simplified for this display. Compressed transfer bytes are not a memory or smoothness guarantee.

See [the alignment protocol](continuous-canvas-alignment.md) and the public `data/alignment.json` for source hashes, limits and the independent-centerline comparison. The comparison uses nearest same-name road geometry; it is not a held-out intersection/image-registration pass. No fit/correction has been performed, and the frozen independent-anchor gate remains unpassed. Typical source agreement cannot certify outliers, the painted street edges or a readable seam.

Cloud Chromium/WebKit checks and independent rendered UX/visual critiques are useful evidence about this diagnostic UI. The revision adds synthetic touch at dense coordinates, keyboard and semantic own-record selection, feed/asset failures and retries, rapid source changes, genuine empty-season handling, and selected-record updates. A reproduced release bug interpreted a semantic click's absent pointer coordinates as a map position and selected a different record; non-pointer activation now keeps the activated record's identity. These checks do not establish physical-iPhone gesture, browser-chrome, memory or VoiceOver behavior, nor that visitors discover displays more easily.

## Sources and regeneration

`data/source-notices.json` retains the context source identities, retrieval time, safe-field allowlist, clipping/simplification method, counts, checksums and use terms. Pinellas County metadata does not state a general reuse license; the preserved notices describe reference use, as-is accuracy/completeness limits and no survey precision. USGS metadata describes the NHD source as open/non-proprietary and requests acknowledgment. Do not reinterpret the package as wholly MIT or ODbL. The original art's OSM notices and Spencer Caton's artwork rights continue to apply; see [map-data.md](map-data.md) and [LICENSE.md](../LICENSE.md).

To regenerate source-derived art (Pillow and svgpathtools required):

```sh
python3 scripts/prepare-continuous-art.py
```

To reacquire the bounded context (Python and GDAL `ogr2ogr` required, with source domains allowed):

```sh
python3 scripts/build-continuous-context.py --evidence /tmp/this-way-context-evidence
```

The context builder updates only `context.geojson` and `source-notices.json`, preserving art metadata siblings. Evidence stays outside `public/`; no source address ranges, contact details or listing/photo data are packaged. Re-run the source-agreement diagnostic after changing art/source inputs; see the alignment note for the command. Inputs are hash-checked before retaining a previous comparison.

## Physical iPhone protocol: early investment gate

After cloud reviewers resolve diagnostic UI defects, record the phone model, iOS/browser, orientation and browser-chrome state. Prefer a lower-memory intended support device if available, and limit conclusions to tested devices.

1. Open the initial canvas in short portrait. Confirm the street map, display points, named art controls, scope, zoom, sources and Map tools are readable and reachable. No original-art quilt should obscure the opening view.
2. Pinch in/out, then pan immediately. Repeat small zoom reversals around the numbered-point threshold. Look for dropped drags, repeated tier switching, image jumps, white flashes or page reloads.
3. Select each named illustration at the same camera; inspect its intentional source edge and the geographic context outside it. Then compare both originals through Map tools. Check road continuations, actual pin anchors, label sizes and the unillustrated context. A camera that pans smoothly does not pass a confusing seam.
4. Use the explicit reset/nearby/frame targets, select each record through the map or coordinate list, and close its identifier. Confirm selection and controls remain visible, with no camera reset on dismissal.
5. Rotate to landscape with browser chrome visible. Scroll Map tools to its last link and use its sticky close, then pan immediately. Repeat on the shortest usable viewport, including a selected long address. Confirm wide-screen styling respects physical safe-area insets.
6. Test slow/failed artwork and listing loads. Geographic pins/base must remain usable; missing feeds must say incomplete/unavailable. Inspect available device diagnostics and distinguish observations from image-buffer estimates.

A failed phone or art/context check stops investment in the full discovery shell. The source/geometry investigation and a representative asset audit may continue while phone evidence is pending. Comparative visitor tasks, representative-map correction effort, county public-data loading/count semantics and finished-shell mobile/accessibility acceptance remain later gates. Passing this pair does not approve all 94 maps.
