# FTW migration rehearsal

The November 3, 2026 rehearsal inspected 40 real public FTW listings from two map
queries. It imported 31 eligible records and five approved public photos into
isolated local D1/R2, then verified public API output, photo bytes, exact replay,
storage restart and browser rendering. No production content was imported.

## Source and limits

Read-only requests to `https://frightthisway.com/api/displays?neighborhood=…`
returned 101 Old Northeast and 35 Crescent Lake displays. The two complete
responses contain 135 unique IDs; one ID appears in both buffered queries.
The selected sample has 40 unique IDs, 20 per query. Four sampled listings have
six public gallery photos in total. Exact response bodies, capture times,
request receipts, hashes, original photo bytes and gallery metadata remain in a
private cloud snapshot outside this repository.

Public `destination.lat/lng` supplies geographic coordinates. The original `x/y`
remain map-space provenance and are never treated as latitude/longitude.
A map query can include nearby-buffer displays; its name does not establish a
listing's home neighborhood. Each candidate target placement is checked against
the exact This Way bounds/core used by submission validation.

The public DTO has no explicit source status, season, description, version,
timestamps, consent, original object key, address-match snapshot or private
review history. Approved visibility and Halloween 2026 are explicit assumptions
from the inspected public-route contract in the retained QA reference, not
per-record export fields or a verified deployed backend revision. The captured
public images are not evidence about pending, rejected or removed source images.

The rehearsal therefore uses the distinct namespace `ftw-public-pilot`. It keeps
source UUIDs and full public DTOs, labels inferred and unavailable fields, and
uses public photo retrieval locators instead of pretending to know original R2
keys. Target version 1 and import timestamps are internal initial values, not
fabricated source history. Nothing is reclassified as Christmas participation.

## Observed result

| Check | Result |
| --- | --- |
| Source records inspected | 40 |
| Eligible target placements | 31: 18 Old Northeast, 13 Crescent Lake |
| Placement exceptions | 9 retained for review; no automatic reassignment |
| Imported private local photo objects | 5; the sixth belongs to an excluded placement |
| Canonical rows | 1 season, 31 locations, 31 listings, 5 photos |
| Source mappings | 68 |
| Synthetic initial review events | 0 |
| Exact second import | All skip; no canonical-row or blob writes |
| Runtime restart | All counts and public photo bytes retained |
| Browsers | Desktop Chromium and phone WebKit, both neighborhoods |
| Real gallery | Landscape and portrait images, ordered next-photo navigation |
| Production content writes | 0 |

The complete dry run records all placement issues; the separately named eligible
plan records exactly which subset is applied locally. Neither silently drops or
moves out-of-coverage listings. Original source metadata, plans, mapping ledger,
asset manifests, reports and real-content screenshots are private artifacts and
are not committed or included in the public site's assets.

## Improvements found by the rehearsal

- A reviewed location-manifest correction was reported as an update but dropped
  when its listing payload was unchanged. Location emission is now independent
  of a skipped listing, and correction/replay regressions cover it.
- Duplicate photo source identities and destination object keys could produce an
  apparently valid plan that failed SQL constraints. They now fail during planning.
- Populated phone carousels overlapped map attribution. Measured carousel height
  now leaves an 8px gap; the third horizontal item remains scrollable/selectable.
  Short landscape controls use the left side to stay clear of raised credits.
- The closest real Old Northeast pins were only about 16px apart at the previous
  viewing zoom limit. Viewing zoom now reaches 4, allowing individual selection
  without changing coordinates. Actual zoom/pan/select checks cover both areas.
  Raster artwork softens at the deepest zoom; pin/interface text stays sharp.
- Image captures wait for decoding and fade completion, and use the actual close
  control before selecting another reference. Gallery membership/order/fit are
  checked against the recorded public gallery response, not a derived selection.

Independent UX and visual reviewers passed the revised actual-data renders.
Physical iPhone gesture behavior is not established by these WebKit captures.

## Run locally in the cloud workspace

Install the repository's locked development dependencies. The rehearsal uses
Miniflare with fixed local D1/R2 bindings; it has no remote mode or production
credential path. Output must be a new private directory outside the checkout,
including after symlink resolution. Inputs and outputs stay local.

```sh
node scripts/rehearse-ftw-import.mjs \
  --public-snapshot /workspace/design-review/ftw-migration-source \
  --output /workspace/design-review/ftw-migration-new-run --capture
```

`--capture` needs the installed Playwright browsers. Set
`CHROMIUM_EXECUTABLE_PATH` when using a system Chromium. `--serve` additionally
keeps a loopback-only preview running until interrupted. Its active season is
local to the rehearsal; production's active season is unchanged.

The version-2 public snapshot adapter verifies the full response hashes, selected
source IDs, recorded gallery membership/order/fit, image bytes and decoded
metadata. It strips unsupported image metadata before storing destination bytes,
records both original and sanitized hashes, and preserves gallery order/fit.

For an already prepared operator bundle, use `--input bundle.json` instead.
The bundle supplies `sourceSystem`, `previewSeason`, `records`, optional
`locationManifest`/`timestampUnit`, and `assetManifest.assets`. Each asset adds a
relative `path` to its sanitized bytes alongside the planner's `sourceKey`,
`objectKey`, `contentHash` (`sha256:` plus 64 hex digits), `mediaType`, `width`, and
`height`. Asset paths cannot escape their bundle directory. The insert-only pilot
requires a fresh target and one supported preview season; source-update or
conflicted plans are not applied. See [the planner contract](ftw-migration.md).

The local store preflights every asset and published location before writing.
It never overwrites different existing object bytes. Canonical rows and source
mappings are inserted in one D1 batch. If that batch fails, only new objects from
that attempt are removed; preexisting objects remain. Synthetic integration tests
also verify hidden listings, pending-photo privacy and an actual SQL rollback.
These cases are separate from the approved-only real source sample.

## Before a production migration

1. Obtain an authorized content export from the current authoritative FTW source,
   with schema/capture information, all intended seasons and listing statuses,
   actual home-neighborhood/address-match data, source IDs, versions, timestamps,
   descriptions, tags, consent where available, and photo moderation/removal
   metadata and original storage keys. Retained QA code has no verified complete
   export route. Private pending/hidden states cannot be recovered from public DTOs.
2. Reconcile referenced photo objects by key, length and hash. Preserve nonpublic
   decisions. Missing, removed and orphan objects need an explicit disposition;
   the pilot does not restore removed photos or require copying orphan blobs.
   Authentication/session/rate-limit state is not content to migrate; any heart
   transfer uses aggregate counts, not browser identifiers.
3. Resolve neighborhood/coverage exceptions and review possible duplicate physical
   locations against source identities. Preserve Halloween seasons separately from
   Christmas. Run the authentic full-field subset through the same checks.
4. Build and review the production apply/restore path: guarded updates that protect
   locally edited rows, atomic row/mapping checkpoints, immutable asset handling,
   batch receipts and recovery. The current store intentionally applies only fresh
   inserts or an exact skip replay. Its rollback test is a local database failure
   exercise, not a production deployment rollback or an approved live import.

A production migration is a separate operation after its concrete plan and source
access are available. Shipping the rehearsal tools and UI fixes does not publish
these FTW records into This Way's production database.

## Validation

All 116 Node/local Worker/D1/R2 checks passed, including planner corrections,
source-proof tampering, local insert/replay/restart, placement filtering, safe
output handling, image validation and a real failed-SQL batch rollback.
The complete Chromium/phone-WebKit suite passed 265 checks with five intentional
project-specific skips. Both isolated submission/private-photo/owner-approval
journeys passed. Revised actual-data UX, visual and independent code reviews
passed. The production deployment gate validates code and service behavior; it
does not run a production data import.
