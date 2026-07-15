# Wiring the reasoning animation ("AI Pulse") — surface-owner recipes

While the real (slow) model runs, a FAST model streams request-tailored
"reasoning" lines ("Analyzing your brief…", "Choosing a palette…") that reveal
one-by-one as a live animation. This lane ships the backend route, a React hook,
and a ticker component; the **vdz Generate panel is already wired** (reference
implementation in `generate-panel.tsx`). Below are drop-in recipes for the other
surfaces, whose files are owned by parallel workers.

## What's delivered (no edits needed)

- **Backend** `POST /api/v1/ai/pulse` — body `{ task: string (≤2k), surface: 'video'|'app'|'image'|'chat' }` → `{ lines: string[] }`. Session-authed, `@Throttle('strict')`, calls `cdz-flash` (low tokens, 8s timeout). **Always 200** with at least a generic fallback array — it can never break your busy UI. Registered in `plugins/copilot/index.ts`.
- **Hook** `modules/vdz/use-ai-pulse.ts` — `const pulse = useAiPulse()` → `{ start(task, surface), stop(), currentLine, done, active }`. Shows local fallback lines instantly, swaps in tailored lines when they land, loops the last 3 if the real request outlives the script.
- **Component** `pages/workspace/vdz/ai-pulse-ticker.tsx` — `<AiPulseTicker line active done />`, a slim pulsing-dot + crossfading-line row (self-contained dark palette). Renders nothing when `!active || !line`.

The React import paths from a page under `desktop/pages/workspace/…`:
```ts
import { useAiPulse } from '@affine/core/modules/vdz/use-ai-pulse';
import { AiPulseTicker } from '@affine/core/desktop/pages/workspace/vdz/ai-pulse-ticker';
```

---

## 1. vdz AI dock (`modules/vdz/use-vdz-ai.ts` + `ai-dock.tsx`)

The dock's `useVdzAi()` already exposes `busy` and `send`. In `ai-dock.tsx`:

```tsx
const pulse = useAiPulse();
const onSend = useCallback(async (text: string) => {
  pulse.start(text, 'chat');            // 'video' if the dock frames edits as video work
  try { await send(text); } finally { pulse.stop(); }
}, [send, pulse]);
// …in the busy region of the dock (where the typing/spinner shows):
{busy ? <AiPulseTicker line={pulse.currentLine} active={pulse.active} done={pulse.done} /> : null}
```

## 2. App builder (`blocksuite/ai/components/ai-tools/clickdz-app-result.ts` — Lit)

This is a LitElement, not React, so mount the ticker with the hook's underlying
route directly (the hook is React-only). Simplest path — fetch once, reveal on a
timer inside the element:

```ts
// on generate start, with `this.prompt`:
const r = await fetch(cdzApiUrl('/api/v1/ai/pulse'),
  { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ task: this.prompt.slice(0,2000), surface: 'app' }) });
const { lines } = await r.json();      // always ≥1 line; wrap in try/catch → generic lines
// then setInterval(1800–3000ms) stepping an index into `lines`, looping the last 3,
// rendering the current line in your existing "Building…" status row. clearInterval on done.
```
Reuse the dot+crossfade look from `ai-pulse-ticker.css.ts` (literal-hex palette).

## 3. Image generation (`blocksuite/ai/components/ai-tools/image-artifact.ts` — Lit)

Same Lit pattern as the app builder, with `surface: 'image'` and the user's image
prompt as `task`. Start the timer when the generation request fires, `clearInterval`
when the image resolves or errors. Fallback lines are image-tailored server-side.

## 4. Chat panel (`blocksuite/ai/components/ai-chat-input/ai-chat-input.ts` — Lit)

For a streaming chat answer, use `surface: 'chat'` and start the ticker on submit,
stopping it as soon as the FIRST real token streams in (the reasoning animation is
only for the pre-token "thinking" gap). Pass the user's message as `task`.

---

## Notes

- **Always stop in a `finally`** so a failed/aborted request still clears the animation.
- **`task`** is a one-line summary of the user's request (≤2k chars, trimmed server-side). The richer/more specific it is, the better the tailored lines.
- **React surfaces** should prefer the hook (`useAiPulse`) + `<AiPulseTicker>`; **Lit surfaces** call the route directly and drive their own reveal timer (recipe #2), since the hook depends on React.
- **Never gate on this** — the route is fire-and-forget cosmetic; the real generation proceeds regardless of whether pulse lines arrive.
