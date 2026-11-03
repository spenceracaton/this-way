# Authenticated FTW pilot operator

The manually dispatched **FTW operator** workflow connects the guarded import
executor to the existing production D1/R2 bindings. It is limited to a reviewed
selection of 5–10 approved source listings, Halloween 2026, Old Northeast and
Crescent Lake, and currently public curated gallery photos. New canonical rows
may be inserted; updates are refused. Exact reruns may correctly insert zero
rows. This pilot is a scoped operation, not a complete FTW migration or evidence
about pending visitor-photo contributions.

The existing authenticated Sites export and subsequent public-route byte checks
support the selected approved records. Each prepare/apply run rechecks their
current public source fields and photo hashes. Rejected records, private-photo
aliases and contribution records are outside this operator's first scope.
Source metadata and unavailable-field decisions remain private provenance.

## Production setup

The workflow uses the existing `production` environment's
`CLOUDFLARE_API_TOKEN`; no new Cloudflare deployment credential is required. The
token needs the same account D1 edit, R2 storage edit and Workers Scripts edit
permissions used by production deployment. The account and destination names
are pinned. D1 resolves through the account list and its exact database UUID;
neither D1 nor the photo bucket is created by this operator.

Add one **production environment secret**, `THIS_WAY_FTW_PILOT_PAYLOAD`, containing
the reviewed private payload JSON. The payload is a bounded source bundle plus
exact approved photo download URLs. Keep its UTF-8 content at most 48 KiB. Its
SHA-256 is calculated after trimming surrounding whitespace; do not otherwise
reformat the reviewed file. No source records, photo keys or private payload
files belong in Git, repository variables, workflow inputs or public artifacts.

The prepared private pilot file and address-level review remain in the cloud
workspace outside the checkout. Use the actual reviewed payload and digest,
not a synthetic fixture. If configuring through an owner-authenticated CLI:

```sh
gh secret set THIS_WAY_FTW_PILOT_PAYLOAD \
  --repo spenceracaton/this-way --env production < /private/path/payload.json
```

The coding integration can manage this repository's PRs and runs, but its
production-secret listing returned HTTP 403. Secret management therefore needs
an authorized repository owner session; a successful PR push does not establish
secret-management permission. No token value is requested in chat or recovered
from existing secrets.

## Run prepare, then apply

Merge this workflow through the release-sensitive owner-review path first.
Wait for the exact `main` revision's normal production workflow and receipt to
pass. The operator refuses a branch ref, stale local checkout, unvalidated main,
unpublished main revision, or publishing pause. It rechecks admission after
deployment of the temporary operator and before the operation.

```sh
gh workflow run ftw-import.yml --ref main \
  -f operation=prepare -f bundle_sha256=REVIEWED_PAYLOAD_SHA256
```

Prepare downloads only the exact `https://frightthisway.com/api/photos/<id>`
URLs in the private payload, refuses redirects, enforces byte limits, checks
original hashes/dimensions/MIME and sanitizes bytes through the source-bundle
loader. Current public addresses, coordinates, display fields and tags must
still match the reviewed source selection. This is a fresh public-visibility
check, not access to private source versions or pending-photo tables.

The temporary Worker proves a failed `D1.batch` rolls back two owned assertion
rows before creating a checkpoint. Prepare writes a durable private checkpoint
and control records, but no canonical listing/photo rows. The GitHub summary
reports aggregate counts, the payload digest, checkpoint ID, private receipt key
and cleanup status. The receipt in the private control bucket contains the
detailed result. Review the exact prepared selection and require zero updates.

```sh
gh workflow run ftw-import.yml --ref main \
  -f operation=apply -f bundle_sha256=REVIEWED_PAYLOAD_SHA256 \
  -f checkpoint_id=EXACT_PREPARED_CHECKPOINT_ID
```

Apply is bound to that checkpoint and payload digest. Source bytes and fields
are checked again. Full baseline assertions, row/mapping writes and the durable
applied marker commit through the real Worker D1 binding in one batch. Immutable
photo creates are verified. Lost responses retry the same operation; existing
checkpoint state prevents duplicate imports. A fresh all-skip checkpoint still
verifies all selected public listing IDs and photo hashes after apply. Existing
unrelated rows and gallery photos are retained.

The pilot remains Halloween 2026. Its data is verified through the season-scoped
listing/photo API; the default map remains configured for Christmas 2026.

## Status and restore

```sh
gh workflow run ftw-import.yml --ref main \
  -f operation=status -f bundle_sha256=REVIEWED_PAYLOAD_SHA256 \
  -f checkpoint_id=EXACT_PREPARED_CHECKPOINT_ID

gh workflow run ftw-import.yml --ref main \
  -f operation=restore -f bundle_sha256=REVIEWED_PAYLOAD_SHA256 \
  -f checkpoint_id=EXACT_PREPARED_CHECKPOINT_ID \
  -f reason='Reviewed pilot recovery'
```

Status reads the durable ledger; it does not assert that no later owner edits
have occurred. Restore compares the checkpoint's post-import baseline and
refuses intervening edits or dependent user data. It preserves immutable blobs
and audit history. Public verification checks that inserted listing IDs are
absent and their photo routes return 404. It never deletes a later reimport in
response to a failed verification. Source downloads are unnecessary for status
or restore, so source removal does not prevent a guarded recovery.

An operation may have committed even if its public verification or response
failed. Inspect status and the private receipt before taking another action.
Never create a new checkpoint merely to conceal an uncertain prior apply.

## Authentication, storage and cleanup

Every operation runs on checked `main` in the protected production environment,
under the same `this-way-production` concurrency lock as releases. Secrets are
injected only into the operator step, after dependency installation. Source
records and detailed errors are never emitted to Actions logs or artifacts.

Each run creates a uniquely named temporary Worker. Its workers.dev HTTPS
`POST /execute` endpoint requires a random 256-bit per-run bearer secret. The
command is read from a private R2 object and pinned by raw SHA-256, run ID and
deadline. Request bodies cannot choose commands, target accounts or SQL. The
Worker permits only the scoped prepare/apply/status/restore operations. The
ten-minute expiry is an admission cutoff; an already-started transaction may
finish after it. New requests fail closed after expiry. Visitor application
routes and owner login authority are unchanged.

The operator creates `this-way-operator-private` only after its exact-name lookup
returns 404. All other lookup failures stop. Managed r2.dev access and every
custom domain must be disabled, and that privacy is rechecked before each
command/receipt upload. `CONTROL` binds that bucket; `PHOTOS` binds the existing
photo bucket. The control bucket contains private source snapshots, before-images
and error details: keep it private permanently.

Command and receipt objects use run-specific keys and remain private recovery
evidence alongside D1 checkpoints. Retention/deletion is a separate owner-reviewed
operation; this workflow does not automatically remove recovery data. Photo
objects are never deleted as compensation for an uncertain commit.

The client verifies a random run-specific ownership marker through Cloudflare's
Worker settings before disabling/deleting its temporary Worker. Cleanup runs
in `finally` and a separate `always()` step, and verifies absence with the account
API. A preexisting Worker or ownership mismatch is never deleted. If cleanup
cannot be verified, the workflow reports failure; expiry still closes new RPC
admission. Do not equate a cleanup attempt with confirmed removal.

The workflow and its credential authority are release-sensitive under
`AGENTS.md`. Spencer must review and merge manually; auto-merge is disabled.
The [checkpoint protocol](ftw-checkpoint-recovery.md) and
[source export requirements](ftw-source-export.md) still govern the broader
migration, including excluded pending/contribution content and unresolved
original private-object evidence.

## Validation

All 149 Node/local Worker checks pass, including bundled Worker authentication,
prepare/apply/status/restore across restarts, expiry/command tampering, account
and scope checks, private control-bucket enforcement, cleanup ownership markers,
payload/hash/current-source checks and public replay/restore verification.
The real selected five-record/five-photo payload also passes fresh source-field
and byte checks plus the authenticated local Worker prepare, atomic rollback
probe, apply, exact retry, status, restore and restore retry. Production bindings
and Cloudflare account API mutations have not been exercised from the coding
workspace; the protected workflow is the reviewed path for that first live test.
