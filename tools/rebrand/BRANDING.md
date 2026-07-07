# ClickDz Work — rebrand layer

ClickDz Work is a rebranded distribution of [AFFiNE](https://github.com/toeverything/AFFiNE)
maintained by ClickDzPro LLC (clickdz.ai) for work.clickdz.ai.

## How it works

Everything brand-related is applied by ONE re-runnable GitHub Actions job:
**Actions → "Apply ClickDz Work rebrand" → Run workflow**. It:

1. Renders the full icon set (desktop .ico/.icns/.png per build channel,
   DMG backgrounds, all web favicons) from the real ClickDZ logo SVGs in
   `tools/rebrand/brand/` — `render_icons.py`.
2. Patches user-visible identity — `apply.mjs`:
   - product name `AFFiNE` → `ClickDz Work` (installers, window titles, i18n
     values in 26 languages, web manifest, Linux metainfo)
   - app ids `pro.affine.*` → `ai.clickdz.work.*`, deep-link scheme
     `affine://` → `clickdzwork://`
   - default cloud endpoints → `https://work.clickdz.ai`
   - auto-update feed → `work.clickdz.ai/api/releases` and update repo →
     `Clickdzpro1/clickdz-work` (never pulls upstream AFFiNE builds)
   - telemetry endpoints → own domain; no analytics tokens are injected in CI
3. Commits the result. If ANY expected patch target is missing (e.g. after an
   upstream sync moved code), the job FAILS so a human looks at it.

## Upstream sync procedure

1. Sync fork with `toeverything/AFFiNE` canary.
2. Re-run the rebrand workflow.
3. If it fails, update the patch table in `tools/rebrand/apply.mjs`.

## What is intentionally NOT changed

- `LICENSE`, `LICENSE-MIT`, `packages/backend/server/LICENSE` and all
  copyright headers — kept per MIT / MPL 2.0 / AFFiNE EE license terms.
- Internal `@affine/*` package names (invisible to users; keeps upstream
  merges clean).
- Only Community Edition features are built and deployed. Enterprise
  (EE-licensed) functionality must not be enabled without an AFFiNE EE
  subscription.

## v2 backlog

- Server-side email template strings (MPL files — allowed, notices kept)
- `affine_installing.gif` Squirrel animation replacement
- Implement `work.clickdz.ai/api/releases` feed so desktop auto-update
  serves our own releases
- In-app docs/help links (currently still point to upstream AFFiNE docs)

## Brand tokens (extracted from clickdz.ai, 2026-07-07)

primary `#2B7FFF` · accent sky `#0EA5E9` · logo blue `#1D4ED8` ·
deep navy `#0B1F3B` · dark slate `#263440` · radius 12px ·
fonts: Space Grotesk (display), DM Sans (body), Cairo (Arabic RTL)
