# FTW baseline

The main community map uses Fright This Way's existing Explore presentation: cream and plum, DM Sans and Fraunces, its curved neighborhood tab, illustrated neighborhood artwork, and house symbol. The Old Northeast opening camera ports FTW's `resetCamera` framing in the same artwork coordinates. Other neighborhoods retain their authored overview bounds.

Reference: `spenceracaton/fright-this-way-qa` at `00ba22299bdedd5bd7e3c2548b90e4e7e74d86d8`, compared with the live FTW map on November 6, 2026. The house symbol is copied from the shared original `#house` SVG definition, with a neutral facade color and no seasonal overlays. Existing artwork licensing continues to apply.

The picker, cards, galleries, forms, API client, storage and moderation remain the existing This Way implementations. Holiday wording and tags already come from `public/season-config.mjs`; the deployed site chooses which holiday to display. Listings appear on the map and pending photos follow the existing separate review flow.

The production map hides the development address directory and shows a compact display count beside the neighborhood name. Explicit sample links and artwork diagnostics remain available for testing; previous atlas experiments have their own URLs. This change does not add FTW's events, rankings, location service or email signup.

## One holiday per site

The public map's `display-season` meta setting in `public/index.html` selects Halloween 2026 for this deployment. Normal visits and old Christmas links resolve to that season; cross-holiday controls are hidden. The storage/service active season stays independent: showing a past season never reopens submissions or relabels records. Sample and diagnostic views remain development tools. A future Christmas site can reuse the code with its own site setting and deployment.

The production smoke test follows the site's declared display season when present and retains its existing active-season fallback for older rollback artifacts. It still checks exact release identity, listing IDs, private-field exclusion, authentication and original artwork dimensions.
