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

## Iteration 4: complete source inventory and three-map batch

The earlier root recursive GitHub tree was truncated. Enumerating all 47 source
cohort subtrees independently found every one of the ten previously missing maps
under `release-source/pipeline-a1a2-b61687a91bd3/current/`, plus Arcadia Gardens
and Crossroads Area. The earlier missing-asset conclusion was incorrect. This is
still retained source evidence at the pinned revision, not production authority.

The new `scripts/ftw-ready-geography-sources.json` records exact asset and metadata
fingerprints for all 12 complete bundles. The ten previously named maps match
maintained QA asset fingerprints and prepared projection/core coverage evidence;
Arcadia Gardens and Crossroads Area have pinned source fingerprints but no
maintained visual fixture. Fetching with `--plan` and `--ids` limits each batch
without repeating the full discovery audit.

The first batch adds Mystic Lake, Stonesthrow, and Holiday Park: 78 maps total,
including the two original sample maps. Every map passed four road anchors,
preserved masks, credits, raster checks, and synchronized server coverage. A fresh
pinned fetch reproduced all 12 configuration/anchor/notice/SVG files byte-for-byte.
Only three rasters were rendered; the earlier 73 were reused.

UX and visual reviewers inspected actual WebKit images at 390×664, 320×568, and
664×390. Their landscape critique led to a compact empty-state card that leaves
more of the map visible. Both reviewers passed the revised captures. The finite
illustrated artwork keeps its original
aspect ratio and whole-neighborhood opening view; zoom exposes street detail.

At this stage the remaining complete bundles were: Bayou Highlands, Coquina Key, Feather Sound,
Harbordale, Orange Terrace, Perry Bayview, Riviera Heights, Arcadia Gardens,
and Crossroads Area. Feather Sound needs source-specific County/USGS adapters;
it must not be relabeled as OSM data. Directory-only names without a verified map
definition require new geography work and are outside the ready-import batch.

Efficiency change: audit and cache the complete source inventory once; fetch
only selected IDs from a recorded plan; review a small batch first and apply
concrete layout lessons before increasing the next batch size.

## Iteration 5: finish the verified ready inventory

Added Bayou Highlands, Coquina Key, Feather Sound, Harbordale, Orange Terrace,
Perry Bayview, Riviera Heights, Arcadia Gardens, and Crossroads Area. The catalog
now contains 87 prepared maps: two original sample studies and 85 geography-only
bundles. Server coverage was regenerated from the same configurations.

Feather Sound required two narrow source adapters. Its independently matched
County road anchors keep `sourceType`, `sourceId`, and `sourceFeatureId`, without
invented OSM identifiers. Credits retain Pinellas County eGIS and USGS NHD, along
with original mixed-source terms, FDOT core-reference URLs, and feature notices.
Unknown providers remain rejected until reviewed. Existing OSM output ordering
is preserved so earlier bundles remain reproducible.

The shared source plan's one fresh pinned fetch produced all 60 geography input
files and two shared registry snapshots. Cached, verified bytes fed both batches.
Nine rasters were generated in scratch preflight and reused in the final import;
the existing 76 imported rasters were reused. All nine maps pass four road
anchors, mask/source/raster integrity, and API coverage synchronization. The
first batch's compact landscape empty state applies without another UI change.

UX and visual reviewers passed all nine maps after inspecting actual phone,
narrow, landscape and zoom WebKit renders. All 27 map/viewport spacing checks
passed. Code review found a request-specific precision note in the QA source;
the public notice export now omits that non-license field, records the omission,
and tests that the request address never enters public output. Original source
hashes and license statements remain intact. A fresh source bundle reproduces
all 36 configuration/anchor/notice/SVG outputs byte-for-byte. All 188 local
catalog/picker browser cases passed across Chromium and phone WebKit; local
Node checks and the real isolated Worker/D1/R2 integration checks also passed.

The complete audit covered 47 source cohorts and 87 distinct public neighborhood
directories. All prepared map bundles found in that inventory are now represented.
The separate St. Petersburg directory has 107 entries; exact ID/name/alias
matching accounts for 73, including Edgemoor's anonymous map ID and Crossroads
Area. The 34 remaining names are recorded in [the backlog](neighborhood-backlog.json).
They need new source/geometry work; a directory name alone is not a ready map.
No claim is made about geography available outside this pinned source audit.

Efficiency change: increase the batch only after the first batch's source,
layout and delivery checks pass; preserve the special provider adapter as a
narrow branch; cache preflight rasters; stop when prepared, attributable sources
are exhausted rather than inventing coverage for the remaining directory.

## Repeating the process

For new areas beyond the retained bundles, follow the
[one-neighborhood preparation loop](county-map-preparation.md). Its research
queue is separate from the 87 accepted maps and the St. Petersburg directory backlog.

Use `scripts/ftw-expansion-sources.json` as the pinned source plan. Preserve source
terms and verify asset/metadata fixture hashes where available. Run scratch
preflight, review coverage/credits/anchors, then generate only changed rasters.
Run the catalog and browser checks, inspect rendered mobile maps with UX and
visual reviewers, fix concrete issues, and record what changed the next batch's
work. Existing sample maps and previously imported geography need not be rebuilt
to evaluate a new batch.
