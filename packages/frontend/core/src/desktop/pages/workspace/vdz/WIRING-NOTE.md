# WIRING-NOTE — media drop: auto-create a missing lane

## Status

Done in this branch (owned files):

- **Durable clip srcs** — clips now persist `vdz-blob:<blobId>` (uploads) or a
  remote https URL (AI / stock), never a session `blob:` object URL. Resolved
  back to a live URL at render time by `useBlobUrl` (see `use-vdz-media.ts`,
  `constants.ts::durableSrcForMedia`, `preview-canvas.tsx`). A saved/reloaded
  timeline now shows real media instead of dead `blob:` URLs.
- **`addTrack` op** — added to `modules/vdz/{ops.ts}` (schema + handler +
  README), pure/validated like every other op. Available to the AI today and
  to future UI. Covered by the ops test suite.
- **`ensureTrackForMedia(timeline, media)`** — a pure helper in `constants.ts`
  that returns the target `trackId` and, when no lane of the media's kind
  exists, a ready-to-run `addTrack` op for a fresh empty lane.

## The remaining 3-line wiring (needs `index.tsx`, owned by a parallel worker)

Today `resolveTargetTrackId` (in `index.tsx`) returns `null` when the timeline
has no lane of the dropped media's kind, and the drop handlers then silently
`return`. In the DEFAULT timeline this never happens (it ships video + overlay
+ audio lanes), so all three kinds drop fine. It only bites a timeline whose
lane was removed or an AI-authored composition that never had, say, an audio
lane. To make the drop always succeed by creating the lane first, replace the
body of the two drop handlers in `index.tsx` to use `ensureTrackForMedia` and
batch the ops. Import is already available from `./constants`.

`handleDropMedia` (currently ~lines 282–293):

```tsx
const handleDropMedia = useCallback(
  (payload: VdzMediaDragPayload, trackId: string, atSeconds: number) => {
    // Honor the explicit drop lane when kind-compatible…
    const preferred = resolveTargetTrackId(payload, trackId);
    if (preferred) {
      run({ op: 'addClip', trackId: preferred, clip: clipFromMedia(payload, atSeconds) });
      return;
    }
    // …otherwise create the lane, then add the clip, as ONE history entry.
    const { trackId: target, addTrackOp } = ensureTrackForMedia(timeline, payload);
    const clip = clipFromMedia(payload, atSeconds);
    runBatch([...(addTrackOp ? [addTrackOp] : []), { op: 'addClip', trackId: target, clip }]);
  },
  [resolveTargetTrackId, run, runBatch, timeline]
);
```

The `addMediaToTimeline` ("+" button) and `handleDropFiles` paths can adopt the
same `ensureTrackForMedia` fallback identically. Add
`ensureTrackForMedia` to the existing `./constants` import.

Because `addTrack`+`addClip` go through the single `applyOps` path, an invalid
lane/clip fails the whole drop cleanly (no half-applied state), and it's one
undo. No error channel change is needed — a valid drop always lands.
