# Fright This Way migration contract

The initial relational schema is in [`migrations/0001_initial.sql`](../migrations/0001_initial.sql). Listings and locations are separate: a location stores the address, optional geographic coordinates, and raw address-match JSON; a listing points to one location and one season. FTW's `x` and `y` are retained in `listings.source_metadata_json` as source projection values. The planner does not guess that they are latitude and longitude.

New valid user submissions can be inserted with listing status `published`. Imported records preserve the legacy visibility decision: FTW `approved`/`published` maps to `published`; `pending`, `hidden`, `rejected`, and `archived` remain distinct. Unknown source statuses stop planning. Photo moderation is independent: source photo status maps separately to `pending`, `approved`, `rejected`, or `removed`, so a pending photo never changes its listing's visibility.

## Planner API

`server/import-ftw.mjs` exports `planFtwImport({ sourceSystem, records, assetManifest, existingMappings, targetRows, seasonMappings, locationManifest, timestampUnit, now })`. It is deterministic and performs no database, network, object-store, or filesystem writes. Its returned arrays are a proposed write plan, not an apply operation. The caller supplies read-only existing mapping/target snapshots to detect conflicts. Existing source mappings take precedence over generated IDs, and listing/photo foreign keys follow those mapped IDs. A mapping whose canonical target is missing is a conflict; the planner never replaces it with a generated ID.

The asset manifest is explicit, even when empty. It maps each original FTW object key to an already available destination asset and metadata:

```js
{
  assets: [{
    sourceKey: 'legacy/object-key',
    objectKey: 'imported/object-key',
    contentHash: 'sha256:…',
    mediaType: 'image/jpeg',
    width: 1200,
    height: 800
  }]
}
```

The planner references these destinations; it does not copy image bytes. This makes the asset-transfer step explicit and keeps missing blobs from becoming apparently valid photos. Legacy `photo_key`/`photo_type`, ordered `photos` or `house_photos` rows, and nested `photo_contributions` with ordered `items` are accepted. A legacy single-photo key is retained alongside visitor contributions. Contribution items are flattened to private `pending` photos while their contribution id, hash, copied address, and timestamp remain in source metadata; an item's explicit status is preserved. Any source photo with `removed_at` is imported as `removed`, even if an inconsistent source status says approved. There is no implicit restore behavior.

Unmapped years default to distinct Halloween seasons (`halloween-2026`, kind `halloween`, name `Halloween 2026`). If source metadata identifies Christmas, winter, or another season kind, planning requires an explicit `seasonMappings[year]` entry naming the destination season. Existing configured destination seasons are referenced without replacing their configuration. This choice is explicit; a non-Halloween record is never routed into a Halloween season by inference.

FTW `x` and `y` are retained as source projection values and are never treated as latitude/longitude. Approved/published records require a neighborhood id plus valid latitude and longitude from their address match or an explicit `locationManifest` entry keyed by source id (or `sourceId:seasonYear`). If that geometry is missing, the plan contains an `unresolved_location` conflict and emits no published listing. Pending, hidden, rejected, and archived records may retain unresolved locations for review. The operator must review any location manifest against the selected neighborhood map coverage before applying it.

Input record IDs are mapped deterministically to canonical IDs using source system, entity type, source ID, and season where relevant. The source identity is also stored in `source_mappings`; season occurrence identity includes its year so a recurring season name remains distinct across years. Listing and photo checksums cover their canonicalized source snapshots. Re-import with the same checksum and target version is marked `skip`; an edited canonical target whose version differs from the last imported version is a conflict; changed source data against an unchanged target is marked `update`. A mapping whose target is missing or lacks a usable imported version is a conflict. A caller should apply only conflict-free plans transactionally and advance source mapping checksums/versions atomically with canonical rows.

Input is bounded to 500 records, 8 MiB of canonical JSON, 2,000 photos total, and 20 photos per listing. Tags and custom tags remain separate JSON arrays, including unrecognized values. `timestampUnit` explicitly selects source timestamps as `milliseconds` (default) or `seconds`; seconds are converted to canonical milliseconds, while raw values remain in source snapshots. Units are never inferred from timestamp magnitude. `now` is always a canonical millisecond epoch value. Reports are independent records and heart data is count-only so browser identifiers are never imported.

`review_events` triggers capture subsequent status changes to listings and photos. Initial imports use direct inserts and therefore do not create synthetic review events. Preserve source review history separately if it is available; the current planner keeps the latest moderation metadata and raw listing/photo snapshots, but intentionally does not invent a complete legacy review-event history.
