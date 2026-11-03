# Neighborhood expansion audit

The original 59 maps came from the QA repository's historical
`release-source/current/` directory. Later QA evidence identified 26 additional
prepared map definitions. Retained directories are source inputs, not current
production source authority. The pinned QA revision is
`00ba22299bdedd5bd7e3c2548b90e4e7e74d86d8`.

## Iteration 1: source inventory and pilot

Recovered seven maps: Azalea, Bahama Shores, Bartlett Park, Gateway, Harbor Isle,
Historic Park Street, and Lake Maggiore Shores. Six maps match maintained QA
fixture hashes for map data, nearby map data, artwork, registry entry, and buffer
configuration. Lake Maggiore Shores has retained source provenance but no matched
fixture assertion in this import.

Preflight found two differences from the first import: mixed-source credit
metadata with missing top-level fields, and OSM IDs expressed as feature IDs
rather than properties. The importer now preserves exact source notices without
imputing a blanket license, recognizes both explicit OSM ID formats, and requires
four matched road anchors. A failed preflight writes no map outputs.

Efficiency change: recover and validate sources before raster work; stage a whole
batch before writing; use scratch output trees to catch mismatches safely.

## Iteration 2: retained catalog cohort

Recovered nine more maps: Allendale Terrace, Historic Uptown, Live Oaks, Northeast
Terraces, Norwood Heights, Oakwood Gardens, Pasadena Vista, Tyrone Gardens, and
West Shore Village. These have pinned retained assets and prepared projections;
they do not have the six pilot maps' maintained-fixture hash assertions.

All nine passed the same source, mask and four-anchor preflight without another
source-format change. The total catalog is 75: two illustrative sample maps and
73 geography-only maps.

Efficiency change: a checked-in per-map source plan selects the correct snapshot
and merges registry entries by ID. Fetch each shared registry once. Render only
changed SVGs; all 57 earlier imported rasters remain reusable. A fresh fetch can
reproduce the new geography without repeating manual source discovery.

## Iteration 3: rendered critique and revision

Actual WebKit renders cover all 16 additions at 390×664, 320×568, and 664×390.
All 48 map/viewport combinations keep credits below the empty-state card with
at least a 6px gap and no horizontal overflow. Independent UX and visual
reviewers identified detached chevrons on wrapped narrow titles. The shared
control now reserves icon columns aligned with the first text line; the full
neighborhood name stays visible. Both reviewers passed the revised captures.

The initial overview made some street labels too small to read. Two real zoom
button presses exposed readable street names; reviewers accepted retaining the
whole-neighborhood opening view. This avoids changing artwork density without
evidence that the existing zoom interaction fails.

Validation includes 81 desktop map/picker cases, 81 phone WebKit cases, and six
targeted post-revision checks across both engines. A fresh pinned source fetch
reproduced 80 map output files byte-for-byte, with raster provenance retained.
Only 16 new rasters were generated; the original 57 were reused. An independent
code review found no blocking issue. Maintained FTW fixture assertions cover six
pilot maps, not all 16 additions.

Efficiency change: read the cloud's existing browser-runtime notes before
launching WebKit. Its verified libraries are installed locally rather than in
the global loader cache. Keep browser runs on one persistent preview server to
avoid overlapping test runners stopping a shared temporary server. After the
title fix, repeat the affected title/credit/picker checks rather than every
unchanged route; required CI still runs the complete browser suite.

## Pending source recovery

Ten areas are referenced by maintained QA but their map assets are absent from
the retained source snapshots checked here:

- Bayou Highlands
- Coquina Key
- Feather Sound
- Harbordale
- Holiday Park
- Mystic Lake
- Orange Terrace
- Perry Bayview
- Riviera Heights
- Stonesthrow

The production build's non-expired distribution artifact was listed by the
GitHub API, but its signed download returned `Forbidden`. These areas need an
accessible source/archive containing the actual geography; QA names and test
expectations alone are not replacement artwork. They have not been added to the
picker with invented maps. The broader St. Petersburg directory also contains
35 names without a map definition found in this audit.

## Repeating the process

Use `scripts/ftw-expansion-sources.json` as the pinned source plan. Preserve source
terms and verify asset/metadata fixture hashes where available. Run scratch
preflight, review coverage/credits/anchors, then generate only changed rasters.
Run the catalog and browser checks, inspect rendered mobile maps with UX and
visual reviewers, fix concrete issues, and record what changed the next batch's
work. Existing sample maps and previously imported geography need not be rebuilt
to evaluate a new batch.
