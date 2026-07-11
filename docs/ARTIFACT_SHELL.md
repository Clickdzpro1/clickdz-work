# ClickDz Artifact Shell — PR foundation

Branch: `feat/cdz-artifact-shell` (from `canary` @ d81a83689)

## Problem
- Image gen used a disposable floating modal (Download / Regenerate / Close) — Close lost the asset.
- App/code previews shared the same “disappear” mental model.
- Whiteboard only reachable via tiny top chrome, not left rail.

## Approach (open-artifacts patterns, AFFiNE-native)
- **In-chat card** + **ArtifactPreviewPanel** (existing split) instead of orphan modal.
- **`artifactStore`** — localStorage shelf so Close never deletes the artifact.
- **`ImageArtifactHost`** — elegant thumbnail + Open / Download / Regenerate.
- **Whiteboard** left-rail button → `createPage('edgeless')`.
- Improved **generating skeletons** for image/iframe renderers in `messages/wrapper.ts`.
- Code artifacts already used `ArtifactTool` correctly; we align images to that path.

## Files
| Path | Change |
|------|--------|
| `modules/ai-artifacts/store.ts` | **NEW** ArtifactStore |
| `blocksuite/ai/components/ai-tools/image-artifact.ts` | **NEW** ImageArtifactHost |
| `blocksuite/ai/components/copy-more.ts` | Persist + render ImageArtifactHost |
| `blocksuite/ai/messages/wrapper.ts` | Skeleton during generating (image + iframe) |
| `blocksuite/ai/effects/shared.ts` + `registry.ts` | Register `image-artifact-host` |
| `components/root-app-sidebar/whiteboard-button.tsx` | **NEW** |
| `components/root-app-sidebar/index.tsx` | Wire Whiteboard under Intelligence |

## Not in this PR (follow-ups)
- Full **Artifacts library** page in left rail (list from `artifactStore`).
- Dedicated **app-builder** tool card (reuse CodeArtifactTool + sandbox iframe).
- **Streaming pacer** (Phase 0) for blue-loop → progressive text.
- Server-side artifact blob persistence (beyond localStorage).

## Test plan
1. Chat → generate image from message action → card appears in thread; panel opens.
2. Close panel → card remains; click Open → panel returns same image.
3. Download / Regenerate work from card and panel.
4. Left rail **Whiteboard** → new edgeless board opens.
5. Code artifact tool still opens preview panel as before.
