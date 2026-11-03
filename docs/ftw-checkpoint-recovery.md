# Guarded FTW import checkpoints

The binding executor supports small inserts, reviewed source updates, exact
retries and compensating restore against D1/R2. Its local command uses isolated
storage. The separate [authenticated pilot operator](ftw-operator.md) connects
an approved-only, selected 5–10-record scope through a manual workflow. It uses
the supplied owner export and fresh public-field/photo checks, preserves Halloween
identity, and permits inserts/skips only. Visitor application routes are unchanged.

The pilot does not establish full source completeness or migrate excluded
visitor-photo contributions. Broader migration still requires the
[source content export](ftw-source-export.md) and source reconciliation described
below. Declared provenance and hashes establish an operator assertion and byte
integrity; they do not prove authorization or source authenticity.

## Checkpoint protocol

1. Load a bounded, explicitly scoped content bundle with actual listing/photo
   states and source seasons. Verify the original photo hashes, decode and
   sanitize their bytes, and reconcile every referenced asset. Unknown statuses,
   missing bytes and unsupported legacy photo shapes block preparation rather
   than silently dropping content. Public-pilot bundles are refused.
2. Read the five canonical content tables in one D1 batch. Plan against that
   consistent baseline, retaining source evidence, before-images, source mappings
   and intended operations in a hashed durable checkpoint. Preparation writes
   only the `prepared` checkpoint, not listings or photos. The artifact names its
   schema/planner contract and is rederived from its input whenever read.
3. Review the private checkpoint and supply its exact ID to apply. Check all
   required photo bytes and existing destination objects before creating any
   missing objects. Keys have the form
   `ftw-import/<sha256-source-key>/<sha256-sanitized-bytes>.<extension>`.
   Conditional creates and post-write reads detect competing writes. Existing
   different bytes are refused. Reused source keys across multiple photo rows
   need reconciliation; the current planner rejects destination key collisions.
4. In one D1 batch, assert the complete reviewed content baseline and unchanged
   checkpoint state/artifact, write canonical rows and source mappings, advance
   the checkpoint to `applied`, and remove assertion rows. Failed assertions use
   a CHECK constraint to abort the entire batch, including any writes already
   attempted in that batch. Location-only corrections are validated against the
   resulting published listings and exact map coverage too.
5. If the batch response is lost, read the durable checkpoint. An applied marker
   proves that rows and mappings committed together. Exact retries inspect the
   resulting target state rather than applying a second time. If the outcome
   cannot be established, stop and inspect the checkpoint; retain staged blobs.
   Neither failed apply nor restore deletes production photo objects.

Listing/photo updates advance canonical versions monotonically, even if the
source did not advance its version. The corresponding `last_imported_version`
advances atomically. Source versions remain in provenance. Every column in the
reviewed content baseline is compared, so a same-version owner edit also blocks
apply. Existing season configuration remains owner-managed.

## Restore

Restore requires the applied checkpoint's exact ID and a reason. It reads its
durable artifact, not editable copies of source files, and compares all five
content tables with the exact post-import state inside the restore transaction.
It reverses inserted/updated rows and mappings and marks the checkpoint
`restored` in that same batch. Restored listing/photo versions continue upwards
and prior mappings follow the restored canonical versions, avoiding stale-client
version reuse. A restored checkpoint cannot be applied again.

Subsequent content edits or new content rows block restore. Foreign keys also
block deleting inserted listings that have since received hearts, reports,
upload tokens or new photos. Review history blocks deleting newly inserted
entities. Existing status reversals append the normal review events; previous
audit events are retained. Restore never resets the entire database or removes
R2 objects. Retained unreferenced import blobs require a separate reviewed
retention decision, not automatic cleanup after an ambiguous commit.

The ledger retains the original artifact, applied/restored timestamps and restore
reason. No source authentication/session/rate-limit state is transferred. Legacy
review history retained in the raw export is not yet a canonical historical-event
import; current state and metadata must not be presented as complete source history.

## Local acceptance command

Keep all bundle files and output outside the repository. The output directory
must be new and private. Each invocation restarts the same local persistent
D1/R2 runtime; no Cloudflare credentials are read.

```sh
node scripts/rehearse-ftw-checkpoint.mjs prepare --local \
  --bundle /workspace/private-ftw-content/bundle.json \
  --output /workspace/private-ftw-checkpoint

# Use the exact checkpointId printed by prepare after reviewing checkpoint.json.
node scripts/rehearse-ftw-checkpoint.mjs apply --local \
  --workspace /workspace/private-ftw-checkpoint --expected-id ftw_REPLACE

node scripts/rehearse-ftw-checkpoint.mjs status --local \
  --workspace /workspace/private-ftw-checkpoint

node scripts/rehearse-ftw-checkpoint.mjs restore --local \
  --workspace /workspace/private-ftw-checkpoint --expected-id ftw_REPLACE \
  --reason 'Recovery acceptance exercise'
```

`workspace.json`, `checkpoint.json`, `last-result.json`, the local database and
asset cache are private artifacts, not site assets. Expected IDs and asset hashes
are checked before apply. Output paths are resolved through symlinks before the
outside-checkout rule is applied. JSON reports use atomic replacements so an
existing report symlink is not followed.

## Deliberate bounds and remaining production work

The first executor accepts at most 25 source listings and 100 photos, with an
additional 250-statement ceiling for both apply and restore. Source image files
are at most 2 MiB. The complete checkpoint artifact is at most 768 KiB, and the
reviewed target snapshot is at most 1,000 content/mapping rows. These limits can
make a smaller batch necessary even below the listing/photo maximum.

The baseline guard deliberately covers all rows in the five content tables.
Any concurrent content change, including an unrelated new submission, requires
a fresh checkpoint. It suits an initial small migration; it is not a continuous
sync engine. It does not freeze the live site or discard the concurrent write.
Larger or active datasets require a separately reviewed per-entity dependency
and chunk protocol, not removal of these guards. There is no automatic source
deletion inference when a row/photo is omitted from a later export.

Before broader production migration: acquire and reconcile the authentic export; resolve
coverage and missing/shared/removed-asset exceptions; review the exact small
batch; and connect the binding executor through an authenticated operator
transport that demonstrates D1 batch semantics. Cloudflare's generic SQL HTTP
endpoint or a series of independent CLI SQL calls must not be treated as an
equivalent transaction without proof. The separately documented pilot operator
uses the Worker D1 binding and proves its rollback behavior before preparation;
arbitrary remote updates remain outside that operator's scope.

The additive `0002_ftw_import_checkpoints.sql` migration creates only private
checkpoint and transaction-assertion tables. Existing public/service queries
remain unchanged. It is a release-sensitive path under `AGENTS.md`, so Spencer
must review and merge this PR manually after its required checks pass.

## Validation

The complete 131-check Node/local Worker suite passes. Checkpoint integration
exercises actual D1 batch rollback, same-version edits, concurrent duplicate
applies, a missing ledger row at commit time, lost apply/restore responses,
monotonic update/restore versions, immutable-object races, private pending photos,
location-only coverage changes, foreign-key/history protection and empty guard
tables after failure or success. The local command passes its persistent
prepare/apply/restart/status/restore lifecycle and private-path/cache checks.
Both Chromium and phone-WebKit submission/photo-approval service journeys pass
with the additive migration applied. Independent code review passed after the
race, coverage, guard-cleanup and binary-ordering corrections. No real FTW content
or production bindings were used in these acceptance tests.
