# Wiring the AI Video Generator ("Generate" mode) — integrator steps

This lane ships three self-contained files and touches nothing the parallel
workers own. The integrator adds a **Generate** mode to the vdz page header and
renders `<VdzGeneratePanel />` when it is active.

## Files delivered (no edits needed)

- `pages/workspace/vdz/generate-panel.tsx` — `<VdzGeneratePanel />` (default + named export)
- `pages/workspace/vdz/generate-panel.css.ts` — its styles (self-contained dark palette)
- `modules/vdz/use-vdz-compose.ts` — `useVdzCompose()` hook (both fetches via `cdzApiUrl`)

## Integration (apply at merge, ~8 lines in the vdz page `index.tsx`)

1. Import the panel at the top of the vdz page:
   ```ts
   import { VdzGeneratePanel } from './generate-panel';
   ```
2. Add a mode to the page's header toggle. If the header already has a mode
   union (e.g. `'edit' | 'data'`), extend it: `type VdzMode = 'edit' | 'data' | 'generate';`
3. Add the tab button beside the existing ones:
   ```tsx
   <button onClick={() => setMode('generate')} data-active={mode === 'generate'}>Generate</button>
   ```
4. Render the panel when the mode is active (it fills its container — give the
   parent a definite height, e.g. `flex: 1; min-height: 0`):
   ```tsx
   {mode === 'generate' ? <VdzGeneratePanel /> : null}
   ```

That's it — the panel owns its own state, live preview, transport, refine, and
download. No providers, routes, or store wiring required.

## Notes for the integrator

- **Backend routes** (already registered in `plugins/copilot/index.ts`):
  `POST /api/v1/vdz/compose` `{prompt}` → `{html}` and
  `POST /api/v1/vdz/compose/refine` `{html, instruction}` → `{html}`.
  Both are `@Throttle('strict')` and return AFFiNE typed errors.
- **Optional barrel export**: if the page prefers importing panels from a
  module, add `export * from '../../pages/workspace/vdz/generate-panel';` where
  appropriate — not required, the direct relative import above works as-is.
- **Preview sandbox**: the composition renders in an iframe with
  `sandbox="allow-scripts"` and `srcDoc`; it has no network and can only reach
  the host via `postMessage`. Do not add `allow-same-origin` — the transport
  bridge relies on the frame staying in an opaque origin (see the comment on
  `postToFrame` in `generate-panel.tsx`).
