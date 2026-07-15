# Vdz

Foundation for **Vdz Studio**, an AI video editor built into ClickDz Work.

This module is the data layer. It defines the timeline document, the edit
contract, and a demo timeline — no UI, no rendering, no Remotion (that lands in
a later PR). The workbench shell that consumes this lives at
`src/desktop/pages/workspace/vdz/` and is reachable at the `/vdz` route.

## What's here

- **`schema.ts`** — Zod schemas and inferred types for the timeline. A
  `VdzTimeline` has `tracks`, each with `clips` (a discriminated union on
  `type`: `video` / `audio` / `image` / `text` / `shape`) and optional
  `transitions`. This is the single source of truth both humans and the AI
  edit. `computeTimelineDuration(timeline)` returns the total length (max clip
  end across tracks), in seconds. All time values are seconds; clip
  positions/sizes (`x`/`y`/`w`/`h`) are canvas fractions (0..1).
- **`ops.ts`** — the edit contract. Every mutation is a `VdzOp` (a discriminated
  union on `op`) applied through `applyOp(timeline, op)` or
  `applyOps(timeline, ops)`. Both are **pure** (never mutate the input) and
  **fail closed**: on any validation error the original timeline is returned
  with an `error` string, and the resulting document is re-validated against
  `vdzTimelineSchema` after every op so an invalid timeline is never emitted.
  `applyOps` stops at the first failing op and reports its index.
- **`sample.ts`** — `createSampleTimeline()`, a ~12s demo used by the shell.
- **`index.ts`** — barrel export.

## The op contract

Ops: `addClip`, `removeClip`, `moveClip`, `trimClip`, `setText`,
`applyTransition`, `removeTransition`, `renameTimeline`.

**AI edits arrive as `VdzOp[]`** — the model proposes a batch of ops, they run
through `applyOps`, and only a fully valid result is committed. See
`clickdz-vdz-prompt.ts` (P1) for the prompt/tool wiring that produces them.
