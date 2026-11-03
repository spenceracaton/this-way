# Production listing service setup

The production Worker serves the map and `/api/` routes on the same origin. Its deployment artifact contains the static site, Worker modules, D1 migrations, and Wrangler configuration. The release verifier checks every file before deployment. Production setup then ensures the two named service resources exist, applies D1 migrations, uploads the owner secrets, and deploys while holding the existing production lock.

## Owner credentials

Run `node scripts/configure-owner.mjs` on a trusted computer. Enter a password of at least 12 characters twice when prompted. The script does not echo the password. It writes a PBKDF2-SHA256 verifier and a random service secret to `~/.config/this-way/owner-secrets.json` with a private file mode. In a managed workspace, choose a workspace-local private path explicitly, such as `node scripts/configure-owner.mjs --output /workspace/.this-way/owner-secrets.json`. It refuses to overwrite an existing file. Keep a secure backup and do not commit or share this file.

Add the two values as **production environment secrets** in the repository's GitHub settings. These commands read the values from the private file through standard input, so the secret values do not appear in shell history or process arguments:

```sh
jq -r .OWNER_PASSWORD_HASH ~/.config/this-way/owner-secrets.json | gh secret set THIS_WAY_OWNER_PASSWORD_HASH --env production
jq -r .SERVICE_SECRET ~/.config/this-way/owner-secrets.json | gh secret set THIS_WAY_SERVICE_SECRET --env production
```

For the workspace path above, use `/workspace/.this-way/owner-secrets.json` in both commands instead.

The production deployment workflow maps these GitHub names to the Worker binding names `OWNER_PASSWORD_HASH` and `SERVICE_SECRET`. The verifier must use 100,000 PBKDF2-SHA256 rounds. The service secret must contain at least 32 characters. Deployment stops before creating or changing Cloudflare resources if either value is missing or invalid.

## Cloudflare resources and releases

The checked-in Wrangler configuration names the D1 database `this-way-listings` and the R2 bucket `this-way-photos`. It intentionally contains no D1 ID placeholder. During an eligible production deployment, the release script uses `CLOUDFLARE_API_TOKEN` to look up those exact names and create either resource only when absent. It does not modify or delete other D1 databases or R2 buckets. The D1 migration command resolves the configured database by name. Permission errors stop deployment; they are never treated as evidence that a resource is missing.

The deployment token needs account-scoped D1 edit, Workers R2 Storage edit, and
Workers Scripts edit permissions for the configured Cloudflare account. The
managed coding workspace does not need that token: local tests use isolated
storage, while the trusted production workflow uses the existing GitHub secret.

For an interactive cloud preview after installing dependencies:

```sh
node scripts/configure-owner.mjs --output /workspace/.this-way/local-owner.json
jq -r 'to_entries[] | "\(.key)=\(.value)"' /workspace/.this-way/local-owner.json > .dev.vars
printf '\nLOCAL_DEVELOPMENT=1\n' >> .dev.vars
chmod 600 .dev.vars
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local
```

The local owner file and `.dev.vars` are private credentials. The former belongs
outside the repository; the latter is ignored. Local D1/R2 state lives under
`.wrangler/`, also ignored. `npm run test:service` instead generates and removes
its own credentials and state automatically.

The migration runs before the Worker deploy. Schema changes must be additive and compatible with the currently active Worker because rollback restores Worker code without reverting D1 changes or deleting R2 objects. Do not put destructive cleanup in a production migration. The release receipt records the D1 ID, resource creation status, successful migration, and owner-secret upload status.

The existing publishing pause and production concurrency lock remain in force. To activate the service, configure the two production environment secrets, then have Spencer review and manually merge the release-sensitive pull request. After it reaches `main`, the regular exact-`main` checks decide whether production publishing is eligible. Rollback only repoints Worker traffic to a previous deployment; it does not reverse migrations or change stored photos.

The manual rollback workflow does not need the owner password or service secret: it restores a previously deployed Worker version, whose secrets remain configured on the Worker. It still requires the existing Cloudflare deployment credential and paused publishing state.
