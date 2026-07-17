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
  - Every clip may also carry two OPTIONAL, backward-compatible fields:
    - `animation` — `{ in?: {kind, duration}, out?: {kind, duration} }` where
      `kind ∈ fade | slide-up | slide-down | slide-left | slide-right |
      zoom-in | zoom-out | pop` and `duration` is seconds (default `0.5`). The
      preview plays `in` from the clip's start and `out` ending at its end.
    - `effects` — an ordered `{ kind, amount }[]` visual-filter stack where
      `kind ∈ blur | brightness | contrast | saturate | grayscale | sepia |
      glow` and `amount` is a normalized `0..1` knob (0.5 is neutral for
      brightness/contrast). Rendered as a CSS `filter`.
    Timelines authored before these existed parse unchanged (both optional).
  - AUDIO clips additionally carry three OPTIONAL mix fields: `fadeIn` /
    `fadeOut` (seconds ramping from/to silence at the clip edges, clamped to
    the clip's duration at playback) and `duck` (when `true`, every OTHER
    audio clip dips to ~30% while this clip plays — mark a voiceover with
    `duck` so music sits under it). Same backward-compat rule: all optional.
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

Ops: `addTrack`, `addClip`, `removeClip`, `moveClip`, `trimClip`, `splitClip`,
`rippleDelete`, `nudgeClip`, `setText`, `applyTransition`, `removeTransition`,
`setAnimation`, `setEffects`, `updateClip`, `setAudioMix`, `renameTimeline`.

- `addTrack` `{track}` — append a whole new track (a full `VdzTrack`; its
  `clips` array is normally empty, since clips are added with `addClip`).
  Rejected if the track `id` already exists. Tracks are appended at the end, so
  the back-to-front z-order still holds (video under overlay; audio is never
  visual). Lets media of a kind with no matching lane (e.g. dropping audio into
  a timeline that has no audio track) create its lane first, then land the clip.
- `splitClip` `{trackId, clipId, atSeconds}` — cut a clip in two at `atSeconds`
  (which must fall strictly inside it). The second part gets id `<id>-b`
  (or a fresh nanoid on collision); for `video` clips its `trimStart` is
  advanced by the cut offset.
- `rippleDelete` `{trackId, clipId}` — remove the clip and shift every later
  clip on that track left by the removed clip's duration, closing the gap.
- `nudgeClip` `{trackId, clipId, deltaSeconds}` — shift `start` by a signed
  delta, clamped so it never goes below 0.
- `setAnimation` `{trackId, clipId, animation}` — set a clip's entrance/exit
  `animation` (the `{in?, out?}` object above), or pass `null` to clear it.
- `setEffects` `{trackId, clipId, effects}` — replace a clip's whole `effects`
  stack; an empty array clears it.
- `updateClip` `{trackId, clipId, patch}` — patch a clip's presentational
  style fields (`name` on every type, plus `text`, `fontSize`, `color`, `x`,
  `y`, `w`, `h`, `align`, `fit`, `volume` per type). Patch keys are validated
  against the clip's `type` (e.g. `fontSize` is rejected on a shape), and
  structural/time fields have their own dedicated ops.
- `setAudioMix` `{trackId, clipId, fadeIn?, fadeOut?, duck?}` — set an AUDIO
  clip's mix fields. Tri-state per field: omit = leave unchanged, `null` =
  clear, value = set (`duck: false` clears like `null`). Rejected on non-audio
  clips.

**AI edits arrive as `VdzOp[]`** — the model proposes a batch of ops, they run
through `applyOps`, and only a fully valid result is committed. See
`clickdz-vdz-prompt.ts` (P1) for the prompt/tool wiring that produces them.
