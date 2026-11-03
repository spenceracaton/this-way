# FTW source content export contract

This contract defines the minimum authentic source package needed to plan a
full FTW content migration. The November 3, 2026 source review found no public
bulk export and no accessible authenticated export interface. The QA mirror is
historical input, not proof of the currently deployed Sites revision. Its
`schema.ts` is useful for naming fields, but the source owner must reconcile it
against the current official Sites source and live D1/R2 bindings before
exporting. Public display DTOs and the 40-listing rehearsal are not substitutes.

## Required package

Deliver a point-in-time package in restricted storage, outside this repository.
Keep the raw export immutable and separate from any normalized planner bundle.
Export all rows for the explicitly selected migration seasons and neighborhoods,
including pending, approved, hidden, rejected, archived, removed, and otherwise
nonpublic content. Preserve stored values and nulls exactly. Include the actual
schema and migration ledger so columns, defaults, indexes, and source revision
can be interpreted. A complete content export means complete within that
declared content scope; it does not require a whole-database backup.

The retained QA schema names these content and provenance tables. Treat the
field inventory below as the QA reference contract; if the authoritative live
schema differs, include its actual full columns and document the difference.

| Table | Required columns from retained QA schema | Purpose |
| --- | --- | --- |
| `submissions` | `id`, `season_year`, `payload_hash`, `address`, `sharing_consent`, `level`, `tags`, `custom_tags`, `address_match`, `photo_key`, `photo_type`, `featured`, `theme`, `approval_method`, `review_reason`, `status`, `x`, `y`, `version`, `created_at`, `reviewed_at`, `reviewed_by` | Listing identity, exact moderation state, source content, timestamps, source geometry and stored address/home-neighborhood match. |
| `review_audit` | `id`, `submission_id`, `actor`, `decision`, `version`, `at` | Listing moderation history. |
| `house_edit_audit` | `id`, `submission_id`, `actor`, `field`, `before_value`, `after_value`, `from_version`, `to_version`, `at` | Owner content-edit history. |
| `house_photos` | `id`, `submission_id`, `object_key`, `content_hash`, `media_type`, `width`, `height`, `position`, `fit`, `created_at`, `removed_at` | Ordered listing gallery, original object references, dimensions, framing, and soft removals. Include removed rows. |
| `photo_contributions` | `id`, `house_id`, `season_year`, `address`, `payload_hash`, `photo_count`, `created_at` | Visitor contribution identity and source context. |
| `photo_contribution_items` | `id`, `contribution_id`, `house_id`, `season_year`, `object_key`, `content_hash`, `width`, `height`, `position`, `status`, `version`, `created_at`, `reviewed_at`, `reviewed_by` | Ordered contribution photos, original keys, moderation state, and review metadata. Include all statuses. |
| `photo_contribution_reviews` | `id`, `photo_id`, `actor`, `decision`, `from_version`, `to_version`, `at` | Contribution-photo moderation history. |
| `dynamic_neighborhoods` | `id`, `name`, `name_key`, `municipality`, `map_json`, `version`, `created_at`, `updated_at` | Source neighborhood identities and map geometry needed to interpret stored matches. |
| `neighborhood_preparations` | `submission_id`, `submission_version`, `area_id`, `base_version`, `map_json`, `match_json`, `created_at` | Preserve reviewed location/map context if needed; exclude the capability `token` field. |

Include season/configuration records for the declared scope that establish
season identity, kind, and dates from the authoritative source, even if that
configuration is not represented by a table in the retained QA schema. Include
source foreign key relationships and row counts by table and season. If old
review/edit history is unavailable, state that explicitly; do not synthesize it
from the current status.

The export must retain `address_match` exactly as stored, including its
neighborhood identity and coordinates where present. Keep `x` and `y` as source
projection values; they are not latitude/longitude. Do not infer a home's
neighborhood from a map query, display buffer, address geocoder rerun, or
projected coordinates. Where a record lacks a stored home-neighborhood match,
preserve that absence for later resolution.

For each referenced R2 object selected for transfer, include the exact original
key, object bytes, byte length, and SHA-256. Reconcile a bucket inventory against
`house_photos` (including removed rows) and every contribution item, and report
missing references, shared references, and orphan keys/metadata. Orphan bytes
are outside the minimum content bundle and need not be copied. Preserve source
gallery/contribution `position` values and row IDs; do not sort by timestamp or
regenerate source keys. Missing referenced bytes, including for removed photos,
need an explicit disposition and block bundle preparation until resolved; do not
silently omit or restore them. R2 and D1 writes are not atomic.

The manifest records capture start/end in UTC, source environment and exact
official source revision, D1 identity and schema/migration version, table row
counts, R2 bucket identity/object count/total bytes, file and object hashes,
and reconciliation totals. State the snapshot consistency method and any
capture-window limitations. If a consistent cross-service snapshot is not
available, preserve the exact capture window and explain that D1 references
and R2 inventory may reflect different instants.

## Exclusions from migration content

Do not put credentials, owner IDs, identity headers, cookies, access tokens,
session identifiers, auth configuration, capability tokens, or rate-limit keys in the export
package. Do not migrate `rate_limits`, login/session state, or other expiring
operational state. Do not export visitor/browser identifiers from `hearts`;
heart transfer, if separately approved, is count-only. Contact details and
visitor identifiers in feedback, neighborhood-interest, and issue-reporting
data are outside this listing/photo content export and require a separate
purpose and retention decision. Do not include them in a migration bundle.

## Authorized acquisition

The available evidence describes Sites backed by D1 and R2 and documents
owner-only review interfaces, but it does not establish an export endpoint,
current deployed source revision, D1 database name/ID, R2 bucket name, or a
read-only grant for this workspace. No authenticated requests or credential
discovery were performed. Therefore the viable acquisition is an owner-run,
audited administrative export from the currently authoritative official Sites
environment, or explicitly granted read-only D1 and R2 administrative access
for that export. The existing public APIs and `/review` pages are insufficient.

1. The source owner confirms the live official Sites revision, D1 binding and
   schema/migration state, R2 binding, and that the environment is the intended
   authoritative source. Reconcile it against the retained QA mirror before
   using its schema as a query guide.
2. The owner uses the authorized platform administration path for that live
   environment to take a read-only D1 export and enumerate/download R2 objects.
   Use the actual database and bucket identifiers shown by that environment;
   do not infer them from this QA copy. If the owner delegates the operation,
   grant only the read access needed for D1 export and R2 list/get, through the
   organization's approved access process. No application owner route or
   private endpoint should be treated as a bulk export unless the source owner
   documents and authorizes it.
3. The exporter captures all required tables, seasons, schema/migration
   records, and bucket objects, then generates the manifest and reconciliation
   report above. Keep raw files and photos in restricted storage. Share only
   the export manifest and a deliberately minimized migration subset with the
   planner operator; preserve private source data under the owner's access
   controls.
4. Reconcile table/season counts, object hashes, ordered photo references,
   statuses, and home-neighborhood/address-match fields before preparing a
   normalized planner bundle. Record any source fields omitted from that bundle
   and retain the raw export as the audit source.

## Bounded planner bundle v1

The operator-facing JSON bundle is a prepared, scoped subset, not the raw
database backup. Its top-level shape is `{schemaVersion:1, provenance,
records, assetManifest:{assets}, seasonMappings?, locationManifest?}`.
`provenance` requires `kind:"authenticated-content-export"`,
`sourceSystem:"fright-this-way"`, `captureId`, `capturedAt`,
`authoritativeSystem`, `exporterVersion`, explicit `timestampUnit`,
`complete:true`, `unavailableFields` (an explicit array, including `[]`), and
`scope:{seasons,neighborhoods}`. Each record must carry its
actual source ID, season year, listing status, and creation timestamp. Each
photo must carry its source ID, original object key, actual status, creation
timestamp, and original position. Public-derived or inferred status/year data
does not satisfy this contract. If the actual source lacks a required field,
declare it unavailable in source provenance and keep that record out of this
bundle pending explicit resolution; do not fabricate a value.

Records use an explicit `photos` array and `photo_contributions` array; aliases
such as legacy `photo_key`, `house_photos`, or `photoContributions` must be
canonicalized before bundling so no referenced item can be silently skipped.
Declared neighborhood scope is checked against a record's stored home match or
an explicit location manifest entry when either supplies an identity.

`assetManifest.assets` has one entry per transferred referenced object:
`{sourceKey, path, originalContentHash, mediaType, width, height}`. Files are
private, bundle-relative paths. The loader verifies original SHA-256, decodes
and sanitizes image bytes, then derives an immutable destination key as
`ftw-import/<sha256(sourceKey)>/<sha256(sanitizedBytes)>.<jpg|png|webp>`. Original source keys stay on the source
records as provenance; the planner receives the destination key and sanitized
hash. Keep source and sanitized hashes distinct. The current loader accepts at
most 25 listings, 100 photos, and 768 KiB of prepared record metadata. A missing
photo object or unresolved removed-photo disposition blocks loading; no removed
photo is restored by omission.

The provenance fields are operator assertions. Bundle validation and SHA-256
checks prove internal consistency and byte integrity, not authenticated origin,
owner authorization, or source completeness. Keep the export receipt and access
authorization with the restricted source evidence; the loader performs no
network requests and cannot establish permissions.

This is the minimum path supported by current evidence, not a claim that the
workspace has authorization to connect to production. The QA source review
found only paginated/per-record owner inspection and per-image routes; those
cannot guarantee a complete, consistent export of all statuses, history,
keys, removed items, and orphaned bytes. The exact administrative command or
export interface must come from the source owner's current environment, since
its identifiers and deployed revision are not available here.
