# This Way delivery

The application is static files in `public/`. `wrangler.jsonc` targets the
user-owned `this-way` Worker. GitHub Actions is the only automatic publisher.
There is no Cloudflare Builds integration, release service, or second forward
publishing workflow.

## Repository setup

Create a GitHub environment named `production`, restrict it to `main`, and store
the Worker-scoped `CLOUDFLARE_API_TOKEN` there. Keep workflow permissions read-only
except for the production jobs' `deployments: write` permission.

Create the repository variable `PRODUCTION_PUBLISHING_PAUSED` with value `false`.
Only a repository administrator changes it. Workflow credentials do not need
permission to mutate repository variables.

Enable auto-merge and protect `main` with strict freshness and the stable
`pr-gate` required check. Do not allow direct pushes or actor bypasses that evade
the pull-request gate.

## Ordinary delivery

1. An agent opens a ready pull request and enables auto-merge.
2. `validate` runs Node checks, prepares the release, performs the Wrangler dry
   run, verifies every deployable file and uploads one immutable artifact.
3. Desktop Chromium and phone-sized WebKit download that artifact by ID, verify
   it and run in parallel against `release/public`.
4. `pr-gate` succeeds only when validation and the complete browser matrix both
   report `success`.
5. The merged `main` commit repeats that exact workflow and produces its own
   artifact. PR artifacts are never promoted.
6. Under the shared production lock, the publisher rechecks the pause value and
   current `main`, verifies the artifact again and deploys it without running the
   release preparation step.
7. A fresh Chromium context checks the hosted release identity, ordinary URL,
   artwork, pins, neighborhood switching and selection. The receipt is marked
   verified only after this check passes.

The Cloudflare token exists only for the publication step. Artifact verification,
browser installation and production smoke do not receive it. The release receipt
records the source, artifact, prior deployment, resulting Cloudflare version and
deployment, publication time and verification outcome.

## Manual recovery and rollback

Routine delivery stops on an uncertain publication or failed production smoke.
It does not retry the production mutation automatically.

1. Set `PRODUCTION_PUBLISHING_PAUSED` to `true` before recovery.
2. Cancel queued publish-capable runs that have not changed production. Allow an
   already-publishing run to finish when practical; interrupting it can create an
   unknown provider outcome.
3. Wait for the `this-way-production` concurrency lock to clear and inspect the
   active Cloudflare deployment.
4. Run **Roll back production** from `main`. Supply the target version UUID, the
   deployment UUID currently expected to be active, and a reason.
5. The workflow rejects stale requests, targets that never served 100% traffic,
   the currently active version and versions from another release history. It
   promotes the existing target without rebuilding and runs the same production
   Chromium check.
6. Fix or revert `main` and let its validation finish while publishing remains
   paused.
7. Confirm no obsolete publish-capable runs remain queued. Set the pause variable
   to `false`, then rerun **Map checks** for the corrected current `main` to
   deliberately release it.

Historical workflow reruns are not categorically fenced forever. The pause,
queue cleanup, current-head check and expected-current rollback check are the
supported recovery controls. If the active Cloudflare state cannot be established,
leave publishing paused and investigate rather than guessing.

Cloudflare code rollback does not restore connected resource state. Only the 100
most recently published Worker versions are eligible for provider rollback.

## Evidence and device testing

Release artifacts and failed browser evidence are retained for seven days; small
receipts are retained for 90 days. Cloudflare's retained versions, rather than an
expired GitHub artifact, provide code rollback.

Phone-sized WebKit validates the frozen artifact but does not replace a physical
iPhone check for rendering or gesture changes. Those changes still require pinch,
drag, scroll, reset and orientation testing on the hosted URL.
