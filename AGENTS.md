# Agent delivery policy

## Ordinary changes

For application code, map content, copy, styling, and ordinary tests:

- Create a focused pull request.
- Run the required validation.
- Enable auto-merge when the change is ready.
- Monitor through exact-`main` validation and eligible production delivery.

## Release-sensitive changes

Treat a pull request as release-sensitive when it changes any of these paths:

- `.github/workflows/**`
- `.github/CODEOWNERS`
- `AGENTS.md`
- `scripts/release.mjs`
- `scripts/require-success.mjs`
- `package.json`
- `package-lock.json`
- `wrangler.jsonc`
- `playwright.production.config.mjs`
- `tests/production.spec.mjs`
- `tests/release.test.mjs`
- `tests/gate.test.mjs`

For a release-sensitive pull request:

1. Run the same required validation.
2. Do not enable auto-merge.
3. Do not merge the pull request, even if every check passes.
4. Explain the trust-boundary change and ask Spencer to review the diff and merge it manually.
5. After Spencer merges it, monitor exact-`main` validation and production delivery normally.

This is an operational owner gate because agent-created pull requests currently use Spencer's GitHub identity, and GitHub does not permit authors to approve their own pull requests. Do not weaken, bypass, or remove this policy without treating that change as release-sensitive.
