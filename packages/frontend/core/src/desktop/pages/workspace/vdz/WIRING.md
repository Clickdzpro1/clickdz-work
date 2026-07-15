# Wiring the AI Dock into the Vdz Studio shell

This document is for the integrator who owns `index.tsx`. The AI Dock ships as
**self-contained** components (`ai-dock.tsx`, `ai-dock.css.ts`) plus a hook
(`../../../../modules/vdz/use-vdz-ai.ts`). Nothing here has been wired into
`index.tsx` yet — do that at merge time using the steps below.

The dock proposes edits; it never touches the timeline. The host owns applying
them. The recommended UX is a **pending-ops diff bar**: the dock's
`onApplyOps(ops, summary)` stages a proposal, a small bar appears with
**Accept** / **Revert**, Accept runs the ops through the timeline's existing
`applyOps` path, Revert discards them. This keeps every edit — human or AI — on
the one validated code path (`applyOp`/`applyOps`).

---

## 1. Imports

`index.tsx` already imports from `../../../../modules/vdz` and `./index.css`.
Add the dock component, and add `applyOps` + the `VdzOp` type to the existing
vdz import.

```tsx
// add to the existing: import { applyOp, computeTimelineDuration, ... } from '../../../../modules/vdz';
import { applyOp, applyOps, computeTimelineDuration, createSampleTimeline, type VdzClip, type VdzOp, type VdzTimeline } from '../../../../modules/vdz';

// new import (place with the other local imports, before `import * as styles`):
import { VdzAiDock } from './ai-dock';
```

> `applyOps` and `VdzOp` are already exported by `modules/vdz` (via `ops.ts`);
> you are only widening the existing import.

---

## 2. Host state (≈10 lines)

Add these next to the existing `useState` hooks in `VdzStudioPage` (which
already has `timeline`/`setTimeline`, `selectedClipId`, `opError`/`setOpError`):

```tsx
// A staged, not-yet-applied AI proposal. null when there is nothing pending.
const [pendingOps, setPendingOps] = useState<{
  ops: VdzOp[];
  summary: string;
} | null>(null);

// The dock proposes edits here; we stage them for review (do NOT apply yet).
const onApplyOps = useCallback((ops: VdzOp[], summary: string) => {
  setPendingOps({ ops, summary });
}, []);

// Accept: run the whole batch through the single validated apply path.
const acceptPendingOps = useCallback(() => {
  setPendingOps(current => {
    if (!current) return null;
    setTimeline(prev => {
      const result = applyOps(prev, current.ops);
      setOpError(result.error ?? null);
      return result.timeline;
    });
    return null;
  });
}, []);

// Revert: discard the proposal untouched.
const revertPendingOps = useCallback(() => setPendingOps(null), []);
```

The dock currently receives the **whole timeline** in one selection field
(`selectedClipId`). The shell tracks a single selected clip id; pass it as a
one-element array (or `[]` when nothing is selected):

```tsx
const selectedClipIds = useMemo(
  () => (selectedClipId ? [selectedClipId] : []),
  [selectedClipId]
);
```

---

## 3. Mount the dock (JSX)

The shell's layout is `root > main > (stage + inspector)` then a `footer`. Mount
the dock as a sibling of the inspector, inside `main`, so it sits on the right
edge as a full-height column. Place it right AFTER the closing `</div>` of the
inspector block and before `main` closes:

```tsx
{/* Inspector … (existing) … </div> */}

<VdzAiDock
  timeline={timeline}
  selectedClipIds={selectedClipIds}
  onApplyOps={onApplyOps}
/>
{/* end of .main */}
```

The dock brings its own width (340px), full height, left border, and dark
palette — it needs no wrapper and no changes to `index.css.ts`.

---

## 4. Pending-ops diff bar

Render the review bar when `pendingOps` is set. The footer already has a spacer
and buttons; drop this in the footer, or as a thin strip just above it. Reusing
the shell's existing `styles.footer*` / `styles.button` classes keeps it on-
palette without editing `index.css.ts`:

```tsx
{pendingOps ? (
  <div className={styles.footer}>
    <span className={styles.footerLabel}>
      <span className={styles.footerDot} />
      {pendingOps.summary} · {pendingOps.ops.length} op
      {pendingOps.ops.length === 1 ? '' : 's'} proposed
    </span>
    <span className={styles.footerSpacer} />
    <button type="button" className={styles.button} onClick={revertPendingOps}>
      Revert
    </button>
    <button type="button" className={styles.button} onClick={acceptPendingOps}>
      Accept
    </button>
  </div>
) : null}
```

Optional polish: while `pendingOps` is set, you can preview the result by
computing `applyOps(timeline, pendingOps.ops).timeline` and rendering THAT in
the preview/timeline (without committing), so Accept just persists what the user
already sees. The `applyOps` result also carries `error` / `errorIndex` if any
op in the batch is invalid against the current timeline — surface it via the
existing `opError` channel if you preview.

---

## 5. Notes & guarantees

- **Validation is doubled on purpose.** The dock already validates every op with
  `vdzOpSchema.safeParse` before calling `onApplyOps`, and `applyOps` validates
  again (and re-checks the whole timeline) on Accept. Malformed ops never reach
  the document.
- **No media is invented.** The AI uses empty `src` / shape+text placeholders
  for media it can't produce, and says so in its summary. Nothing to handle
  host-side beyond the normal placeholder rendering the shell already does.
- **Do not** import from or edit `use-vdz-ai.ts` / `ai-dock.*` here — they are
  closed over their own state. The only surface you touch is the three props.
- The dock manages its own chat history, busy state, abort, and error display
  internally; the host only needs the pending-ops wiring above.
```
