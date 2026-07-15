# Vdz × Remotion — Dependency Feasibility Report

**PR F (experimental) · branch `feat/vdz-remotion` · verdict: FAILURE (blocked in this environment)**

This PR was gated on a single question: can we add `remotion` +
`@remotion/player` to `packages/frontend/core/package.json` and regenerate the
root `yarn.lock` from inside the build environment? The answer here is **no**,
for an environmental reason that has nothing to do with the code. This document
records exactly what was attempted, why it failed, and the concrete path that
*will* work (a CI job). The composition layer itself is straightforward and is
sketched at the end so it can land the moment the lockfile exists.

---

## 1. What was attempted (and the exact failure)

The package manager is pinned and was driven exactly as the repo expects — no
global/ambient Yarn was used:

| Setting | Value (verified) |
| --- | --- |
| `packageManager` (root `package.json`) | `yarn@4.13.0` |
| `.yarnrc.yml` → `yarnPath` | `.yarn/releases/yarn-4.13.0.cjs` |
| `.yarnrc.yml` → `nodeLinker` | `node-modules` |
| `.yarnrc.yml` → `npmRegistryServer` | `https://registry.npmjs.org` |
| Node | `v24.14.1` |

Yarn 4.13.0 was confirmed live via `node .yarn/releases/yarn-4.13.0.cjs
--version` → `4.13.0`. Corepack activation was unnecessary because the vendored
release runs directly under node.

**The blocker is network egress.** Every npm registry endpoint is refused at the
proxy layer *before* any TLS/registry logic runs. The environment ships a
network filter (`Server: Hyperagent-Network-Filter`) that returns **HTTP 403**
for the registry domains, with this body:

```
Domain "registry.npmjs.org" is blocked by network policy. To access this
domain, use the RequestNetworkAccess tool with domain: "registry.npmjs.org"
and a reason explaining why access is needed.
```

Confirmed blocked (HTTP 403, Hyperagent-Network-Filter) for **all** of:

- `https://registry.npmjs.org/remotion` (the configured registry)
- `https://registry.yarnpkg.com/remotion` (the classic mirror)
- `https://registry.npmmirror.com/remotion` and `https://cdn.npmmirror.com/`
  (the mirror already referenced in `.npmrc` for the Electron binary)

The block is client-agnostic. It is **not** a `curl`-only artifact — Yarn's own
node HTTP stack (which honours `NODE_EXTRA_CA_CERTS=…/hyperagent-proxy-ca.crt`)
hits the identical wall:

```
$ node .yarn/releases/yarn-4.13.0.cjs npm info remotion --fields version
➤ YN0035: The remote server failed to provide the requested resource
➤ YN0035:   Response Code: 403 (Forbidden)
➤ YN0035:   Request Method: GET
➤ YN0035:   Request URL: https://registry.npmjs.org/remotion
```

There is also **no offline fallback**: a filesystem sweep found zero cached
remotion artifacts anywhere on the image — no `remotion-npm-*.zip` in the Berry
global cache, no `remotion` directory in any `node_modules`. So resolution would
have to hit the network, and the network refuses.

**Consequence for `yarn install --mode update-lockfile`:** it never got a chance
to run meaningfully. That command still has to *resolve* the new dependency
graph — `remotion` alone drags in a large `@remotion/*` transitive tree
(`@remotion/media-parser`, renderer/bundler helpers, `remotion/no-react`, etc.)
plus their sub-dependencies — and every one of those metadata + tarball fetches
would 403. There was consequently no point spending the 8-minute `timeout 480`
budget to watch it fail on the first fetch; the pre-flight `yarn npm info` (the
exact same egress path `install` uses) is the faithful, fast proof.

I also could **not** determine the precise current `4.0.x` patch to pin
(`remotion@latest` off the registry is itself a blocked request), so no version
number is asserted anywhere in this PR — pinning a guessed version would be
worse than pinning none.

### Repo state left behind

Clean. `package.json` and `yarn.lock` were **never modified** — only read-only
`yarn npm info` / `curl -I` probes were issued, so there was nothing to revert
(`git checkout` was unnecessary; `git status --porcelain` is empty for both
files). Baseline `grep -c remotion yarn.lock` = **0**. No file in this PR imports
`remotion` or `@remotion/player`, so nothing here breaks `tsc`/build.

---

## 2. Why this is an environment limit, not a code problem

Nothing about adding these two packages is unusual. `remotion` and
`@remotion/player` are ordinary public npm packages; `@remotion/player` is a
thin React component with a small dependency surface. In a normally-networked
developer machine or CI runner the flow is boring:

```bash
# edit packages/frontend/core/package.json (add the two deps, alphabetical)
YARN_ENABLE_SCRIPTS=0 yarn install --mode update-lockfile   # resolve + rewrite yarn.lock only
git add yarn.lock packages/frontend/core/package.json
```

The **only** missing ingredient is registry egress. The remedy is to perform the
resolution where egress is allowed — CI — and commit the resulting lockfile.

---

## 3. Recommended path: regenerate the lockfile in a GitHub Action

Run the lockfile update on a runner that can reach `registry.npmjs.org`, then
have the job commit the rewritten `yarn.lock` back to the branch. `--mode
update-lockfile` writes **only** `yarn.lock` (no `node_modules` linking), so the
job is fast and side-effect-free, and `YARN_ENABLE_SCRIPTS=0` keeps dependency
lifecycle scripts from running during resolution.

Two ways to use the workflow below:
- **Manual / on-demand:** dispatch it (`workflow_dispatch`) against
  `feat/vdz-remotion` after the `package.json` deps are added.
- **Guarded auto:** it also triggers on pushes that touch
  `packages/frontend/core/package.json`, so editing the deps and pushing is
  enough to get a lockfile commit back.

Add the deps to `packages/frontend/core/package.json` first (alphabetical,
exact-pinned to the current 4.0.x — resolve the exact patch on the runner, e.g.
`yarn npm info remotion --fields version`):

```jsonc
// packages/frontend/core/dependencies (illustrative — pin the real 4.0.x patch)
"react-router-dom": "^6.x.x",
"remotion": "4.0.x",
"@remotion/player": "4.0.x",   // NB: '@remotion/player' sorts under '@' with the other scoped deps,
                               //     not next to 'remotion'. Place it in the scoped-packages block.
```

`.github/workflows/vdz-remotion-lockfile.yml`:

```yaml
name: vdz-remotion-lockfile

on:
  workflow_dispatch:
  push:
    branches: [feat/vdz-remotion]
    paths:
      - packages/frontend/core/package.json

# Least-privilege: only allow the token to write repo contents so it can
# push the regenerated lockfile back to the feature branch.
permissions:
  contents: write

concurrency:
  group: vdz-remotion-lockfile-${{ github.ref }}
  cancel-in-progress: true

jobs:
  update-lockfile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # Check out the feature branch head so we can commit back to it.
          ref: ${{ github.head_ref || github.ref_name }}

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      # Use the repo-pinned Yarn (Corepack reads `packageManager: yarn@4.13.0`).
      - name: Enable Corepack
        run: corepack enable

      # Resolve-only: rewrites yarn.lock, no node_modules, no install scripts.
      - name: Regenerate lockfile
        env:
          YARN_ENABLE_SCRIPTS: '0'
        run: yarn install --mode update-lockfile

      # Sanity gate: fail loudly if remotion did not actually land in the lock.
      - name: Verify remotion entries present
        run: |
          count="$(grep -c 'remotion@' yarn.lock || true)"
          echo "remotion entries in yarn.lock: $count"
          test "$count" -gt 0

      - name: Commit lockfile if changed
        run: |
          if git diff --quiet -- yarn.lock; then
            echo "yarn.lock unchanged — nothing to commit."
            exit 0
          fi
          git config user.name  'vdz-bot'
          git config user.email 'vdz-bot@users.noreply.github.com'
          git add yarn.lock
          git commit -m 'chore(vdz): regenerate yarn.lock for remotion deps'
          git push
```

After that job lands a lockfile commit on the branch, the composition layer
(below) can be added and this `FEASIBILITY.md` deleted.

### Alternative if you don't want a bot-commit workflow

- **Local dev machine / self-hosted runner with egress:** run the two commands
  from §2 by hand and push. Same outcome, no automation.
- **Vendored offline mirror:** if this sandboxed environment must stay
  air-gapped, pre-populate the Yarn Berry global cache (or a
  `yarn config set npmRegistryServer <internal-mirror>` pointing at an
  allow-listed internal registry) with the full `remotion` +
  `@remotion/player` transitive closure, then `--mode update-lockfile` resolves
  from cache with no egress. This is heavier to maintain than the CI job.
- **Grant egress to this environment:** allow-list `registry.npmjs.org` for the
  network filter (the filter's own 403 body names the mechanism —
  `RequestNetworkAccess`). Then the vanilla flow in §2 works in-place. This is
  the smallest change if a human operator can flip the allow-list.

---

## 4. What ships the moment the lockfile exists (Phase 2A preview)

The code side is low-risk and reads entirely from the already-merged
`../schema.ts` (`VdzTimeline`, the `VdzClip` discriminated union,
`computeTimelineDuration`, and top-level `fps` / `width` / `height`). Two units:

1. **`remotion/vdz-composition.tsx`** — a generic composition that renders a
   `VdzTimeline` with Remotion primitives:
   - one `<Sequence from={Math.round(clip.start * fps)}
     durationInFrames={Math.round(clip.duration * fps)}>` per clip;
   - `<OffthreadVideo>` / `<Audio>` / `<Img>` for `video` / `audio` / `image`
     clips (empty `src` → a styled placeholder `<div>`, matching the
     schema note that an empty string renders a placeholder);
   - absolute-positioned `<div>`s for `text` / `shape` clips, with all
     positions/sizes read as 0..1 canvas fractions × `width`/`height`;
   - `interpolate(useCurrentFrame(), …)` opacity envelopes for `fade`
     transitions on clip boundaries; `slide` / `wipe` left as explicit `TODO`
     comments (only `fade` is in scope for this PR).

2. **`desktop/pages/workspace/vdz/player-preview.tsx` (+ `.css.ts`)** — a
   `<VdzPlayerPreview timeline playheadSeconds onFrameUpdate />` wrapping
   `@remotion/player`'s `<Player>`:
   - `component={VdzComposition}`, `inputProps={{ timeline }}`;
   - `durationInFrames={Math.round(computeTimelineDuration(timeline) * fps)}`,
     `compositionWidth/Height` from the timeline;
   - `controls` **off** — the host timeline UI owns transport and drives the
     player via a `PlayerRef.seekTo(playheadSeconds * fps)` effect.

`index.tsx` is owned by a parallel worker and must **not** be edited here; the
integration is gated behind a `localStorage` flag (`vdz:remotion-preview`) that
swaps the existing DOM preview for the `<Player>`, per the wiring notes that
accompany the Phase 2A code.

**Bottom line:** the feature is implementable and low-risk; it is blocked solely
by registry egress in this environment. Regenerate `yarn.lock` via the CI job in
§3 (or grant egress), then land the composition layer.
