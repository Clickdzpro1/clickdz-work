# CDZ AI Frontend Upgrade Plan — Model Picker, Council, Mode Pill

Grounded in a read-only pass over ClickDz Work (AFFiNE fork) at
`/agent/workspace/clickdz-work`:

- `packages/frontend/core/src/blocksuite/ai/components/ai-chat-input/preference-popup.ts`
- `packages/frontend/core/src/modules/ai-button/services/models.ts`
- `packages/frontend/core/src/blocksuite/ai/components/ai-chat-input/ai-chat-input.ts`
- `packages/frontend/core/src/blocksuite/ai/chat-panel/message/user.ts`

And the CDZ AI backend at `/agent/workspace/cdz-ai/index.mjs`,
`/agent/workspace/cdz-ai/README.md`.

---

## 0. Current state, precisely

**`models.ts`** defines `AIModel { name, id, version, category, isPro,
isDefault }`. Real models come from a GraphQL query
(`getPromptModelsQuery` → `currentUser.copilot.models`); `category`/`version`
are derived by splitting `name` on the first space (`"ClickDz Smart"` →
category `"ClickDz"`, version `"Smart"`). If that query fails, a **hardcoded
fallback list** (`CLICKDZ_FALLBACK_MODELS`) kicks in with fake/legacy
models: `clickdz-smart`, `clickdz-council`, `clickdz-fast`,
`clickdz-arabic`, plus raw `claude-sonnet-5` and `gemini-2.5-pro`. Council
mode today is a **client-side illusion**: `COUNCIL_MODEL_ID =
'clickdz-council'` is not a real model on the backend — selecting it just
sets `modelId` to that string, and `ai-chat-input.ts` intercepts `send()`
to prepend a large prompt-injection briefing (`[ClickDz Council — members:
...]`, ~15 lines of formatting rules) so that whatever single model
actually receives the request *pretends* to be three models. `user.ts`
then regex-matches that exact briefing (`COUNCIL_BRIEFING_RE`) to hide it
from the user's chat bubble and show a small "🏛️ member names" chip
instead.

**`preference-popup.ts`** renders the model list as a sub-menu of
`menu.action()` rows, each with a single-letter "chip" derived from
`category.slice(0,1)` (`C`, `G`, `o1`, `o3`, `Claude` all map through a
`data-cat` CSS selector to a hardcoded color). There is a second sub-menu,
"Council members," that lets the user hand-pick 3 of the *other* models to
sit on the fake council (`DEFAULT_COUNCIL_MEMBERS = ['claude-opus-4-8',
'gemini-3.1-pro-preview', 'gpt-5.5']`, capped at `COUNCIL_SEATS = 3`,
rotates oldest-out on 4th pick).

**`ai-chat-input.ts`** additionally owns: the Chat|Council mode pill
(`.chat-mode-toggle`, two buttons wired to
`aiModelService.setCouncilMode(true/false)`), the 🎨 image-mode button and
🚀 app-mode button (mutually exclusive, each intercepts `send()` and hits
`/api/v1/images/generations` or `/api/v1/apps/generate` instead of the
normal chat runtime), and inline result cards (image preview, app iframe
with browser-chrome, staged loading text with an elapsed-seconds clock).

**Now, CDZ AI (`index.mjs`) makes `cdz-council` real.** `/v1/chat/completions`
with `model: "cdz-council"` triggers `runCouncil()`, which calls Claude
Opus 4.8, Gemini 3.1 Pro, and GPT-5.5 **in parallel via
`Promise.allSettled`**, then a 4th call to GPT-5.5 synthesizes a verdict.
The backend's own output format (`### <member name>` sections, then
`### ⚖️ Council synthesis`) is **already byte-for-byte the same shape**
the frontend's prompt-injection briefing asks a single model to fake today.
This is the crux of the whole upgrade: the frontend was compensating for a
capability the backend didn't have; now it does, and every compensating
mechanism becomes either redundant or actively wrong.

`/v1/models` on the backend returns `{ id, object, created, owned_by,
description }` for the 7 supermodels — **no `version`, no `icon`, no
`category` field**. This matters: the frontend's existing
`name.split(' ')` trick for deriving category/version won't produce
anything sane from `id`s like `cdz-sage` or descriptions like `"Deep
reasoning and nuance (Claude Opus 4.8)."` The GraphQL `getPromptModelsQuery`
path (which returns `{name, id}` per model, category info is
frontend-derived) is presumably still what actually populates
`aiModelService.models` in production — the CDZ AI backend is the engine
behind the scenes, reached through some existing gateway/copilot service,
not a source the frontend calls directly today. **Open question 1** below
flags this explicitly; it changes which file needs the real edit.

---

## 1. New model picker lineup: 7 CDZ supermodels + version badges + icons

**Icons reality check first:** the task references icons at
`/agent/workspace/cdz-ai/icons/*.png` — **that directory exists but is
currently empty** (verified `ls`). What does exist is
`/agent/workspace/cdz-ai/logos/` with 4 wordmark/brand PNGs
(`cdz-bluegrad.png`, `cdz-light.png`, `cdz-navy.png`, `cdz-skyblue.png`,
~54-65KB each — these read as full CDZ brand lockups, not small per-model
glyphs). **There are no per-model icon assets yet.** Any implementation
plan has to either (a) design 7 small square icons before touching the
picker, or (b) ship v1 with generated glyph badges (a colored square + 1-2
letters, exactly like today's provider chips) and layer in real icon PNGs
later. Recommendation: **do (b) first, (a) as a fast-follow.** The chip
system already exists and works; swapping in real icons later is a
one-line change per row once assets land. Don't block the model-list
rewrite on asset production.

**Proposed lineup** (replace `CLICKDZ_FALLBACK_MODELS` and, ideally, the
live model source — see Open Question 1) with exactly 7 entries, ordered by
expected use frequency:

| id | display name | badge | one-line description (tooltip) | speed tier |
|---|---|---|---|---|
| `cdz-ultra` | CDZ Ultra | "Auto" | Smart-routes every request to the best real model automatically. | Variable (depends on route) |
| `cdz-council` | CDZ Council | "3×" | Claude Opus 4.8 + Gemini 3.1 Pro + GPT-5.5 answer in parallel, then synthesized. | Slow (~20s) |
| `cdz-sage` | CDZ Sage | "4.8" | Deep reasoning and nuance — Claude Opus 4.8. | Standard |
| `cdz-architect` | CDZ Architect | "5.5" | Code, systems, and step-by-step builds — GPT-5.5. | Standard |
| `cdz-scholar` | CDZ Scholar | "3.1" | Research, structure, and long documents — Gemini 3.1 Pro. | Standard (premium-depth tier) |
| `cdz-flash` | CDZ Flash | "3.5" | Instant answers for everyday questions — Gemini 3.5 Flash. | Fast |
| `cdz-polyglot` | CDZ Polyglot | "5.4" | Arabic, French and English mastery, Algeria-aware — GPT-5.4. | Standard |

The "version badge" is literally the number that's already embedded in
each model's *name* per the platform's own naming convention (Sage **4.8**,
Architect **5.5**, Scholar **3.1**, Flash **3.5**, Polyglot **5.4**) —
that's a gift: it means `version` doesn't need deriving from a
`name.split(' ')` hack, it can be a small static map, or better, encoded
directly in the model metadata so the frontend never guesses.

**Concrete changes to `models.ts`:**

1. Add a `CDZ_SUPERMODELS: AIModel[]` constant (replacing
   `CLICKDZ_FALLBACK_MODELS`) with the 7 rows above, each carrying an
   explicit `version` field (`"4.8"`, `"5.5"`, `"3.1"`, `"3.5"`, `"5.4"`,
   `"Auto"`, `"3×"`) rather than deriving it. Set `category: 'CDZ'` for
   all seven, and add a new field the current `AIModel` interface lacks:
   `iconKey?: string` (e.g. `'cdz-ultra'`) so the picker can look up an
   icon path without string-mangling the id.
2. Set `isDefault: true` on `cdz-ultra` only (see section 3).
3. Decide whether raw passthrough IDs (`claude-opus-4-8`,
   `gemini-3.1-pro-preview`, `gpt-5.5`, etc.) stay selectable. They still
   exist on the backend (`PASSTHROUGH` map in `index.mjs`) but the CDZ
   README frames them as a power-user/API-only escape hatch, not a
   consumer-facing choice. **Recommendation: drop them from the picker
   entirely.** They're redundant with the 5 named supermodels (each is a
   1:1 wrapper around exactly one of those raw IDs plus a system prompt)
   and their presence is exactly why today's list feels "mixed" — a
   `Claude Sonnet` row sitting next to `ClickDz Smart` with no visual
   hierarchy. Keeping the picker to 7 rows is also the whole point of the
   ask ("replace the mixed list with the 7 CDZ supermodels").
4. Council-specific storage keys (`AI_COUNCIL_MEMBERS_KEY`,
   `DEFAULT_COUNCIL_MEMBERS`, `COUNCIL_SEATS`, `getCouncilMembers`,
   `toggleCouncilMember`) — see section 2 for whether these survive.

**Concrete changes to `preference-popup.ts`:**

1. Replace the `chipInitial = model.category.slice(0, 1).toUpperCase()`
   line with a lookup against the new `iconKey`/`version` fields. Render
   either:
   - v1 (no assets yet): keep the colored-square chip but put the
     `version` string inside it instead of a single letter (`"4.8"` fits
     fine at `font-size: 11px` in a 22×22 box — may need to bump width to
     ~28px for two-character-plus-dot strings like "4.8"). Add one new
     `data-cat='CDZ'` CSS rule with a CDZ brand color (pull from the
     `logos/` PNGs' dominant palette, e.g. purple/blue like the existing
     `#6e56cf` already used for council/image-mode accents elsewhere in
     the codebase — reuse it for visual consistency, don't invent a new
     brand color here).
   - v1.1 (icons land): swap `<span class="ai-model-chip">` for
     `<img class="ai-model-icon" src="/icons/${model.iconKey}.png" />` at
     ~22×22px, keep the badge text as a small overlay corner-pill or move
     version into `menu.action()`'s existing `info` slot (currently used
     for the "Default" pill) — e.g. show `Default` OR the version badge in
     that slot, not both crowding one row.
2. Description-as-tooltip: `menu.action()` doesn't currently accept a
   native tooltip prop that's rendered anywhere in this file, but the row
   is a real DOM node — the simplest correct approach is a plain HTML
   `title` attribute on the row's wrapping element, which needs a tiny
   change to `class` → also passing through a `title` in the `prefix`/
   row markup, OR wrapping `model.name` display in a `<span title=...>`.
   Given the existing menu system's rows are opaque `menu.action()`
   objects (not raw markup you fully control), the pragmatic move is to
   put `title=${model.description}` on the `prefix` `<div>` — that div is
   real markup you author directly in this file, so it'll pick up the
   native browser tooltip without fighting the menu framework. This is a
   ~5-line change, not a redesign.
3. Sub-menu label: currently reads `${this.model.value?.category}` in the
   trigger button (line ~497, `chat-input-preference-trigger-label`) —
   with all 7 models sharing `category: 'CDZ'`, that trigger would always
   say "CDZ" regardless of which model is active, which is a regression
   (today it shows `ClickDz`/`Claude`/`Gemini` distinctly). **Fix:** change
   the trigger label to show `model.value?.name` or a short form of it
   (e.g. "Ultra", "Sage") instead of `category`. One-line change, but easy
   to miss — flagging explicitly.

---

## 2. Council message decoration + member picker, now that `cdz-council` is real

This is the part of the task most likely to be underestimated, so being
blunt: **there are three genuinely different council mechanisms live
across backend + frontend right now, and only one of them should survive.**

1. Backend `runCouncil()` in `index.mjs` — real, fixed 3-vendor council
   (Opus 4.8 + Gemini 3.1 Pro + GPT-5.5), **not configurable by the
   caller**. No API parameter exists to swap members; the trio is
   hardcoded in the `members` array (`index.mjs` lines ~205-209).
2. Frontend prompt-injection council in `ai-chat-input.ts` `send()` — fakes
   a 3-member council on *whatever single model* is currently selected,
   with members drawn from `aiModelService.getCouncilMembers()` (user's
   customized trio via the "Council members" sub-menu).
3. Frontend member-picker UI in `preference-popup.ts` — lets the user swap
   any 3 non-council, non-image models into the fake council's roster.

Once `cdz-council` is a real backend model, sending `model: "cdz-council"`
to `/v1/chat/completions` produces the *actual* multi-vendor answer with
*hardcoded* members — completely ignoring whatever the user picked in the
"Council members" sub-menu. **If the frontend keeps decorating the request
with the prompt-injection briefing on top of a real `cdz-council` call, two
things go wrong simultaneously:** the injected briefing's member list
(user's customized picks) will disagree with the actual synthesis's member
list (always Opus/Gemini Pro/GPT-5.5), and the model receiving the
briefing is now itself one of three parallel calls inside `runCouncil` —
each of those 3 sub-calls would independently see the "produce one section
per member... under 120 words..." instructions and could try to comply
with formatting rules meant for the orchestrator, not for a single
council member. This is a real double-decoration bug, not a hypothetical
one — it happens automatically the first time someone selects `cdz-council`
after this backend upgrade, with zero frontend changes.

**Recommendation: simplify, don't keep as v2.** Specifically:

1. **Delete the prompt-injection briefing entirely** for the case where
   `modelId === COUNCIL_MODEL_ID` — that whole block in `send()`
   (`ai-chat-input.ts`, the `userInput = ['[ClickDz Council — members:
   ...]', ...]` construction, roughly 25 lines) goes away. The backend now
   does the real work; the frontend just needs to send the user's raw
   question as `model: "cdz-council"` and receive back text that already
   has the `### Member` + `### ⚖️ Council synthesis` structure — which,
   not by coincidence, is exactly the shape `runCouncil()` emits natively.
2. **Delete the "Council members" sub-menu** from `preference-popup.ts`
   (the `councilCandidates`/`councilMemberItems`/second `menu.subMenu`
   block) and the supporting state in `models.ts`
   (`getCouncilMembers`, `toggleCouncilMember`, `DEFAULT_COUNCIL_MEMBERS`,
   `COUNCIL_SEATS`, `AI_COUNCIL_MEMBERS_KEY`). It's picking members for a
   fake council that no longer exists; the real council's roster is fixed
   server-side. Keeping this UI would let users configure something with
   zero effect — worse than removing it, because it actively misleads.
3. **Keep, and slightly relabel, the "🏛️ member names" chip** in
   `user.ts` — but repoint what it displays. Today it renders whatever
   member names got prompt-injected (`COUNCIL_BRIEFING_RE` captures the
   list from the injected text). With injection gone, there's no text to
   regex out of the user's own message anymore — the user's message is
   now just their plain question, nothing to hide. The chip's *purpose*
   (a quick visual cue "you're in council mode") is still valuable, so:
   move it to the **input area** as a small always-visible indicator when
   `modelId === COUNCIL_MODEL_ID` (near the mode pill, not on each sent
   message) showing the fixed roster, e.g. `🏛️ Claude Opus 4.8 · Gemini
   3.1 Pro · GPT-5.5`. Delete `COUNCIL_BRIEFING_RE`,
   `STANDARD_RESET_RE`, and the matching logic in `user.ts`'s
   `renderContent()` — none of it has anything left to match once
   injection is gone. The `STANDARD_RESET_RE` mode-reset mechanism in
   `send()` (the `[ClickDz mode: standard]` injection when switching *out*
   of council) also becomes unnecessary: that existed only to stop a
   single model from continuing to imitate the fake council format in
   later turns; a real backend council with a fixed synthesis format
   doesn't leak formatting into subsequent non-council turns the same way
   (the model receiving a plain `cdz-sage`/`cdz-ultra` request afterward
   has no memory of `runCouncil`'s internal instructions — that context
   lived only inside the injected prompt, which no longer exists). Verify
   this empirically once the backend switch lands (send council → switch
   to Sage → confirm no bleed-through), but the mechanism should no longer
   be structurally required.
4. **Rendering the council answer** on the frontend needs one small
   addition, not present today: the plain chat bubble renderer has no
   special handling for `### Member` headers — it'll currently render
   council answers as an undifferentiated markdown wall with H3 headings.
   Worth a follow-up (not blocking, not required for correctness) to give
   `### ⚖️ Council synthesis` a distinct visual treatment (e.g. a colored
   left-border bar echoing the `.council-briefing-chip` purple, or a
   collapsible per-member section) — this is a "nice to have" polish item,
   listed here for completeness but scoped separately from the
   simplification above, which is the actually necessary change.

**Net effect:** council goes from "3 files of fake-it machinery"
(injection prompt + member picker + regex-based hiding) to "select
`cdz-council`, send, receive real 3-vendor answer, maybe style the
headings." That's a genuine simplification, and it removes a whole class
of bug (double-decoration, member-list mismatch) that the backend upgrade
would otherwise introduce silently.

---

## 3. Default model: `cdz-ultra`, and mode-pill semantics

Today `isDefault` sits on whatever the GraphQL `defaultModel` field
returns (production path) or `clickdz-smart` (fallback path,
`preference-popup.ts` line 25). **Set `cdz-ultra`'s `isDefault: true`** in
the new `CDZ_SUPERMODELS` list — this is a one-line flag flip, no
structural change. It's the right default because `cdz-ultra`'s whole
purpose (per both the README and `ultraRoute()` in `index.mjs`) is to
absorb the "which model do I even want" decision on the user's behalf,
which is exactly what a sane default should do for a 7-option picker.

**Mode pill semantics change more than they might look:**

Today, "Chat" vs "Council" is a **two-state toggle standing in for**
"is `modelId` the special council string or not" — `setCouncilMode(true)`
sets `modelId = COUNCIL_MODEL_ID` and stashes whatever was selected before
into `AI_PRE_COUNCIL_MODEL_KEY` so flipping back restores it. This works
because there used to be exactly one axis of variation the pill needed to
represent: council-vs-not. Post-upgrade, the model picker itself already
represents "council or one of 6 non-council supermodels" — `cdz-council`
is just item #2 in the same 7-row list, selectable the same way as any
other model. **The pill and the picker now overlap in what they express.**
Two reasonable resolutions, pick one deliberately (don't let both survive
by accident, that's how you get two controls that can disagree):

- **Option A — remove the mode pill entirely.** Selecting `cdz-council`
  in the model picker *is* the mode switch; the picker already shows
  which model (including council) is active via the trigger label. This
  is the cleaner design and matches "council is just model #2 now," but it
  is a visible UI removal a user might notice and ask about — call it out
  explicitly in release notes / changelog if this path is taken.
- **Option B — keep the pill as a shortcut, but make it a thin proxy over
  model selection rather than a separate piece of state.** `Chat` click →
  `aiModelService.setModel(<last non-council model, or cdz-ultra if
  none>)`; `Council` click → `aiModelService.setModel('cdz-council')`. No
  more `AI_PRE_COUNCIL_MODEL_KEY` stash/restore logic — that complexity
  existed to solve a problem (remembering the pre-council model) that
  simple "last selected non-council model" tracking already solves more
  generally, and which the picker's own selection state can supply for
  free (`aiModelService.modelId.value` before the council click *is* the
  value to restore).

**Recommendation: Option A.** The pill's only job was faking a
council/non-council binary the model list didn't otherwise expose. Now
that the list exposes it natively (council sits right there as a
selectable row, with its own badge and description tooltip), a second
control for the same fact is redundant surface area — one more place for
the UI to visually disagree with itself if picker and pill ever get out
of sync (e.g., after this change, is the pill checking
`modelId === COUNCIL_MODEL_ID` correctly on every render path? that's a
bug class Option A deletes by construction, not by discipline). If there's
a product reason to keep a fast one-click council toggle (e.g. it tests
well, or muscle memory), Option B is the fallback — but build A first and
measure before adding B back.

Either option removes `setCouncilMode()` from `models.ts` in its current
"stash and restore" form; Option B keeps a much smaller version of it,
Option A deletes it outright along with `AI_PRE_COUNCIL_MODEL_KEY`.

---

## 4. Small UX wins

- **Descriptions as tooltips** — see section 1, item 2 above (native
  `title` attribute on the row's `prefix` div in `preference-popup.ts`;
  the 7 descriptions already exist verbatim in `index.mjs`'s
  `SUPERMODELS` map and should be copied into the frontend's model
  metadata rather than re-written, so the UI and the backend never say
  different things about the same model).
- **"Powered by CDZ AI" touch** — cheapest, lowest-risk win in this whole
  plan. Two placement options, can do both:
  1. Static line under the model sub-menu's option list in
     `preference-popup.ts` (e.g. a `menu.group()` footer row, small
     secondary-text, non-interactive) — "Powered by CDZ AI" with one of
     the `logos/cdz-*.png` wordmarks at ~14px height if a horizontally-
     compact variant exists, else text-only (the 4 existing logo PNGs
     read as full lockups — check actual pixel dimensions before using
     one inline at small size; a squished wordmark looks worse than no
     logo).
  2. Small caption under the trigger button or near the mode pill in
     `ai-chat-input.ts`, shown only occasionally / on first use (a
     one-time "New: 7 real CDZ AI models" callout would fit the existing
     `.clickdz-image-caption`-style secondary-text pattern already used
     elsewhere in this file for image/app result captions — same visual
     language, near-zero new CSS).
  Keep this genuinely small — a persistent, prominent badge risks feeling
  like an ad inside a chat input a user is trying to type in. One quiet
  line is a "touch"; three loud banners is not.
- **Latency expectations per model** — the task explicitly calls out
  "flash fast, council ~20s." Concretely:
  - `cdz-flash` (Gemini 3.5 Flash): per the parallel research already
    saved to `/agent/workspace/cdz-ai/research/gemini.md`, 3.5 Flash is
    explicitly built as a "fast/high-throughput tier" model "tuned to run
    fast and cheap." Fair to label this model **"Fast"** in the UI with
    real confidence.
  - `cdz-council`: makes 4 sequential-dependent LLM calls total (3
    parallel via `Promise.allSettled`, then 1 more for synthesis that
    waits on all 3) — realistically the slowest option in the lineup by a
    wide margin, matching the task's "~20s" figure. Label as **"Slower —
    ~20s, 3 models + synthesis"** rather than hiding the wait.
  - `cdz-sage` / `cdz-architect` / `cdz-scholar` / `cdz-polyglot`: single
    engine call each, comparable to each other — label **"Standard"** as a
    shared tier rather than inventing distinct numbers per model without
    real measured data. `gpt.md`'s research on Engine 5.5 notes it
    "matches the prior generation's response speed" — nothing suggests
    Architect is meaningfully slower than Sage/Scholar/Polyglot; don't
    fabricate false precision.
  - `cdz-ultra`: latency **inherits whatever model `ultraRoute()` picks**
    (`index.mjs` lines ~190-200 route on regex heuristics over the
    prompt) — so its true latency varies request-to-request. Label as
    **"Varies — routes to the best model for your question"** rather than
    a fixed speed claim; anything more specific would be misleading since
    the same `cdz-ultra` request could resolve to Flash-speed or
    Sage-speed depending on what was typed.
  - Concrete implementation: a small `latencyHint` field alongside
    `version` in the model metadata (`"fast"` / `"standard"` / `"slow"` /
    `"variable"`), rendered as a tiny secondary-line under the model name
    in the picker row (below or beside the description tooltip target),
    not as a numeric ETA promise (numeric latency claims age badly and
    will be wrong the moment Make.com webhook or vendor latency shifts).

---

## 5. Implementation order, with file paths

Ordered so each step is independently shippable and testable — no step
requires a step after it to already exist, and nothing here requires
guessing at unmeasured backend numbers.

1. **Model metadata source of truth.**
   `/agent/workspace/clickdz-work/packages/frontend/core/src/modules/ai-button/services/models.ts`
   — replace `CLICKDZ_FALLBACK_MODELS` with `CDZ_SUPERMODELS` (7 rows, per
   section 1's table), extend the `AIModel` interface with `description`,
   `iconKey`, `latencyHint` fields, set `isDefault: true` on `cdz-ultra`
   only. **This is the highest-leverage single edit** — everything else
   in the plan reads from this list.
   - **Open Question 1, flag before starting:** confirm whether
     `initModels()`'s live GraphQL path (`getPromptModelsQuery` →
     `currentUser.copilot.models`) already returns the 7 CDZ supermodels
     from some existing gateway wrapping `index.mjs`, or whether that
     query still returns the old mixed list and only the *fallback* path
     needs updating. If the GraphQL path is the one actually serving
     production traffic today, the real fix is upstream of this repo (in
     whatever service resolves `getPromptModelsQuery`) and this frontend
     change is only correct for the fallback/offline case — worth a
     30-minute check against a running instance or the GraphQL schema
     before writing code, since it changes which system needs the actual
     fix.
2. **Council simplification (backend-driven changes only).**
   - `/agent/workspace/clickdz-work/packages/frontend/core/src/blocksuite/ai/components/ai-chat-input/ai-chat-input.ts`
     — delete the council-briefing injection block and the
     `STANDARD_RESET_RE`-triggering reset block inside `send()`; for
     `modelId === COUNCIL_MODEL_ID`, just send the plain user text.
   - `/agent/workspace/clickdz-work/packages/frontend/core/src/blocksuite/ai/chat-panel/message/user.ts`
     — delete `COUNCIL_BRIEFING_RE`, `STANDARD_RESET_RE`, and the
     matching branches in `renderContent()`; the message is now always
     plain text, no regex needed.
   - `/agent/workspace/clickdz-work/packages/frontend/core/src/modules/ai-button/services/models.ts`
     — delete `getCouncilMembers`, `toggleCouncilMember`,
     `DEFAULT_COUNCIL_MEMBERS`, `COUNCIL_SEATS`,
     `AI_COUNCIL_MEMBERS_KEY`.
   - **Ship and test this step in isolation before touching the mode
     pill** — verify a `cdz-council` request round-trips correctly with
     no injected briefing and renders the real `### Member` / `###
     synthesis` markdown cleanly as plain text first, before doing any
     visual polish on it.
3. **Mode pill decision (Option A recommended).**
   `/agent/workspace/clickdz-work/packages/frontend/core/src/blocksuite/ai/components/ai-chat-input/ai-chat-input.ts`
   — remove `.chat-mode-toggle` markup + CSS + the two button handlers if
   Option A; otherwise rewire per Option B in section 3.
   `/agent/workspace/clickdz-work/packages/frontend/core/src/modules/ai-button/services/models.ts`
   — remove or shrink `setCouncilMode` and `AI_PRE_COUNCIL_MODEL_KEY`
   accordingly.
4. **Picker UI upgrade** (badges, descriptions-as-tooltips, member-picker
   removal, trigger-label fix).
   `/agent/workspace/clickdz-work/packages/frontend/core/src/blocksuite/ai/components/ai-chat-input/preference-popup.ts`
   — this is the biggest single-file diff in the plan: swap the chip
   render to show `version`, add `title=${model.description}` on the
   prefix, delete the entire "Council members" `menu.subMenu` block
   (`councilCandidates`/`councilMemberItems`), fix the trigger label to
   read `model.value?.name` instead of `category`.
5. **Icons, if/when assets exist.** Once real per-model PNGs land at a
   served path (they do **not** exist yet at
   `/agent/workspace/cdz-ai/icons/` — that directory is empty today),
   swap the chip `<span>` for an `<img>` in the same file from step 4.
   Treat this as a follow-up PR, not a blocker for 1-4.
6. **Latency hints + "Powered by CDZ AI."** Small, low-risk, can land
   whenever — add the `latencyHint` field from step 1's metadata to the
   row markup in `preference-popup.ts`, add the footer/caption line per
   section 4. Good candidate for a separate, easy-to-review PR since it
   touches no logic, only presentation.

**What's explicitly out of scope / not addressed here:** image-mode (🎨)
and app-mode (🚀) buttons in `ai-chat-input.ts` are untouched by this
plan — they're orthogonal to model selection (they intercept `send()`
before any model is even consulted, hitting separate
`/api/v1/images/generations` and `/api/v1/apps/generate` endpoints) and
nothing in the CDZ AI model upgrade changes their behavior or interface.

---

## Executive summary (6 lines)

Replace the mixed model list in `models.ts`/`preference-popup.ts` with
exactly the 7 CDZ supermodels, defaulting to `cdz-ultra`, using version
numbers (4.8/5.5/3.1/3.5/5.4) as badges since no per-model icon PNGs exist
yet at `/agent/workspace/cdz-ai/icons/` (that folder is empty — ship
color-chip badges first, real icons as a fast-follow). The council system
needs simplifying, not extending to v2: with `cdz-council` now a real
3-vendor backend model, the frontend's prompt-injection briefing
(`ai-chat-input.ts`) and member-picker sub-menu (`preference-popup.ts`)
become redundant and actively dangerous — left in place, they'll
double-decorate real council calls with instructions meant for a fake one,
so both should be deleted, along with the regex-based hiding logic in
`user.ts`. The Chat|Council mode pill should be removed outright (Option
A) since council is now just model row #2 in the same picker, not a
separate axis needing its own control — keeping both risks the two
controls disagreeing. Small wins (tooltip descriptions, a quiet "Powered
by CDZ AI" line, honest latency labels — Fast/Standard/Slower/Varies
rather than fabricated numeric ETAs) are cheap and low-risk, and can ship
independently of the harder council/pill work. Suggested order: model
metadata first (`models.ts`), council de-decoration second
(`ai-chat-input.ts` + `user.ts`), mode-pill removal third, picker UI
polish fourth, icons/latency-copy last. One real unknown flagged before
coding starts: whether the live GraphQL model query already serves CDZ
supermodels in production, or only the offline fallback list needs this
fix — a 30-minute check against the running system, not a guess.
