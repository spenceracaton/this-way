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

No new GitHub secret is required. The reviewed private payload stays in the cloud
workspace. A protected `upload-key` run creates an RSA-3072 key pair for one
payload digest and checked commit, with a one-hour admission lifetime. Only its
public receipt is published in the `ftw-upload-key` artifact. Its private key is
stored in the private control bucket, never in an artifact or workflow input.
Keep the UTF-8 payload at most 40 KiB; its digest trims surrounding whitespace.
Do not otherwise reformat the reviewed file or commit source records/photo keys.

## Create a key, seal locally, then prepare and apply

Merge this workflow through the release-sensitive owner-review path first.
Wait for the exact `main` revision's normal production workflow and receipt to
pass. Every operation refuses branch refs, stale/dirty checkouts, unchecked or
unpublished main revisions, and a publishing pause. No production import is
performed by installing this workflow.

```sh
gh workflow run ftw-import.yml --ref main \
  -f operation=upload-key -f bundle_sha256=REVIEWED_PAYLOAD_SHA256
```

After that run succeeds, seal the actual reviewed payload in the cloud workspace:

```sh
node scripts/seal-ftw-operator-payload.mjs \
  --input /private/path/payload.json --run-id UPLOAD_KEY_RUN_ID \
  --expected-commit EXACT_LIVE_MAIN_SHA --output /private/path/prepare-inputs.json

gh workflow run ftw-import.yml --ref main --json < /private/path/prepare-inputs.json
```

The sealer authenticates GitHub run metadata, current main, successful exact-SHA
checks, live release and the run's unique public-key artifact before encryption.
It refuses arbitrary pasted keys, wrong-run receipts, private keys and expired
keys. The output contains ciphertext and public routing metadata only, created
with mode 0600. Native AES-256-GCM protects the payload; RSA-OAEP/SHA-256 wraps a
fresh random AES key. Both bind repository, commit, exchange, digest, fingerprint
and expiry. Combined workflow inputs must fit GitHub's 65,535-byte limit.

Do not paste plaintext into workflow inputs or chat. A changed main revision or
expired key requires a fresh upload-key run and newly sealed inputs. Keep the
old checkpoint ID for recovery; do not create a replacement checkpoint to hide
an uncertain apply.

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
node scripts/seal-ftw-operator-payload.mjs \
  --input /private/path/payload.json --run-id UPLOAD_KEY_RUN_ID \
  --expected-commit EXACT_LIVE_MAIN_SHA --operation apply \
  --checkpoint-id EXACT_PREPARED_CHECKPOINT_ID \
  --output /private/path/apply-inputs.json

gh workflow run ftw-import.yml --ref main --json < /private/path/apply-inputs.json
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

After durable apply, public verification and an exact retry succeed, explicitly
revoke the exchange key:

```sh
gh workflow run ftw-import.yml --ref main \
  -f operation=revoke-key -f bundle_sha256=REVIEWED_PAYLOAD_SHA256 \
  -f exchange_id=EXACT_UPLOAD_EXCHANGE_ID
```

Expiry blocks new decryption but **does not delete the stored private key**.
Revocation verifies matching exchange ownership and deletion without removing
commands, receipts or checkpoints. Missing/unknown keys are not reported as
verified owned deletions. Revoke unused or expired exchanges as well. Do not
revoke after prepare or an uncertain apply until status/recovery is understood.

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

Status and restore need no encrypted payload or exchange key, including after
expiry/revocation. Restore reasons are public workflow inputs: keep them generic.
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

Each prepare/apply/status/restore run creates a uniquely named temporary Worker.
Upload-key and revoke-key use only the scoped account storage client. Its workers.dev HTTPS
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

Validation covers bundled Worker authentication,
prepare/apply/status/restore across restarts, expiry/command tampering, account
and scope checks, private control-bucket enforcement, cleanup ownership markers,
payload/hash/current-source checks and public replay/restore verification. An
unrelated database/network error cannot count as the expected CHECK failure in
the atomic rollback probe.
The real selected five-record/five-photo payload also passes fresh source-field
and byte checks plus the authenticated local Worker prepare, atomic rollback
probe, apply, exact retry, status, restore and restore retry. Production bindings
and Cloudflare account API mutations have not been exercised from the coding
workspace; the protected workflow is the reviewed path for that first live test.
