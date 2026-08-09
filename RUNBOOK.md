# ClickDz Work — Deployment RUNBOOK

> **Source of truth:** public repo `Clickdzpro1/clickdz-work`, branch `canary`.
> The private repo is stale — do not use it.

## Ship path (canary deploy)

1. **Merge to canary** — `canary` is the source of truth. All commits land here.
2. **Build the image** — run the GitHub Action `build-clickdz-image.yml` via `workflow_dispatch` with `revision-tag=canary`.
   - Takes ~15–30 min (or ~8–15 min with Docker layer cache on cache hit).
   - Pushes `ghcr.io/clickdzpro1/clickdz-work:canary-<SHA9>` to GitHub Container Registry.
3. **Set BASE_IMAGE on Railway** — on the `humanizily-backend` service (Railway project `clickdz-work`, env `production`):
   ```
   BASE_IMAGE=ghcr.io/clickdzpro1/clickdz-work:canary-<SHA9>
   ```
   Setting a Railway variable **auto-triggers a redeploy** — no manual redeploy needed.
4. **Verify** — check `data-version` on the site matches the new SHA9, and inspect boot logs for errors.

### The 9-char SHA rule

The image tag uses a **9-character** short SHA (`${GITHUB_SHA::9}` in the workflow), **NOT** the 7-char `git rev-parse --short` default. Always use the exact tag from the workflow run. Example: `canary-077ddaaa3` (9 chars), not `canary-077ddaa` (7 chars).

## Rollback procedure

1. Identify the last known-good SHA9 tag (use `scripts/rollback.sh` or check `git log --format='%H' -20 | cut -c1-9`).
2. Set `BASE_IMAGE` on Railway `humanizily-backend` to the prior good tag:
   ```
   BASE_IMAGE=ghcr.io/clickdzpro1/clickdz-work:canary-<PRIOR_SHA9>
   ```
3. Railway auto-redeploys. Verify `data-version` on the site + boot logs.

See `scripts/rollback.sh` for an automated rollback helper.

## Golden rules (NEVER violate)

1. **Green CI build ≠ runs.** A green image build means the bundle compiled — it does NOT mean the app boots. Always watch boot logs for `UnknownDependenciesException` and NestJS DI errors.
2. **Typecheck is non-blocking.** The typecheck workflow fails on every run with a pre-existing baseline of 111 errors in `__tests__/` and e2e. It is a ratchet — it only blocks if the count *increases*. Do not treat typecheck failure as a blocker; check whether *your* edited files have *new* errors.
3. **Server-guards is the functional gate.** The `clickdz-server-guards` workflow (`clickdz-money-guards` job + `ci-gate` job) is the blocking functional gate. It must pass before shipping.
4. **Image build is the ship gate.** `build-clickdz-image.yml` is the final gate — if it fails, there is no image to deploy.
5. **Never sed French curly apostrophes.** The French curly apostrophe (U+2019, `’`) inside single-quoted JS strings is intentional — it does NOT break swc-loader. Converting it to ASCII `'` DOES break the build. Use curved U+2019 inside `'...'` strings, or use template literals (backticks) / double quotes.
6. **The private repo is stale.** Canary is the source of truth. Do not push to or deploy from the private repo.
7. **Repo is PUBLIC.** Never commit secrets. Use Railway sealed variables for sensitive values.

## CI workflow map

| Workflow | Purpose | Blocking? |
|---|---|---|
| `build-clickdz-image.yml` | Builds + pushes Docker image to GHCR (ship gate) | Yes — ship gate |
| `clickdz-server-guards.yml` | Fast unit tests for clickdz money/auth code + `ci-gate` | Yes — functional gate |
| `build-images.yml` | Reusable image build pipeline (called by `build-clickdz-image.yml`) | Called by ship gate |
| `build-test.yml` | Upstream AFFiNE CI (CodeQL, tests) — gated to upstream repo only | No (gated) |
| `release-cloud.yml` | Upstream AFFiNE cloud deploy — gated to upstream repo only | No (gated) |
| `release-desktop.yml` | Upstream AFFiNE desktop release — gated to upstream repo only | No (gated) |
| `release-mobile.yml` | Upstream AFFiNE mobile release — gated to upstream repo only | No (gated) |

## Railway service details

- **Project:** `clickdz-work` (ID: `2db22118-85ba-4f0c-bdde-70afb29bb41f`)
- **Environment:** `production` (ID: `e20e157a-7465-4896-a728-d85c01615541`)
- **Service:** `humanizily-backend` (ID: `f080c2b7-55ee-4f6f-999a-f58f99f27841`)
- **Key variable:** `BASE_IMAGE` — pins the deployed Docker image tag. Setting it auto-triggers a redeploy.

## Owner actions (not done by CI commits)

- **Railway sealing:** Seal 24+ plaintext secrets in Railway UI (Variables → click each → Seal). No rotation needed.
- **GitHub Secret Scanning:** Enable in repo settings → Code security and analysis → Secret scanning + push protection (free for public repos). Then run `trufflehog git https://github.com/Clickdzpro1/clickdz-work --only-verified`.
- **Branch protection:** Repo settings → Branches → `canary` → require the `ci-gate` status check before merge.
- **Secret rotation:** Rotate `DATABASE_URL` password + `OPENAI_IMAGE_API_KEY` after sealing.
