# Migration Plan: ClickDz Work AI -> CDZ AI

Target: repoint ClickDz Work's copilot subsystem from the Vercel-hosted
Make.com bridge to **CDZ AI** (`https://cdz-ai-production.up.railway.app`),
a real OpenAI-compatible multi-vendor endpoint, with minimum blast radius.

Files inspected (read-only):
- `packages/backend/server/src/plugins/copilot/clickdz-bridge.controller.ts`
- `packages/backend/native/src/llm/core/model_registry.rs`
- `packages/backend/native/src/llm/assets/prompts/built-in.json` (Chat With AFFiNE AI prompt)
- `packages/frontend/core/src/modules/ai-button/services/models.ts`

Files also inspected to ground the plan (not in the READ list, but necessary
to get exact values right):
- `packages/backend/server/src/plugins/copilot/config.ts` (provider config schema)
- `packages/backend/server/src/plugins/copilot/providers/openai.ts` (how `baseURL`/`oldApiStyle` become native config)
- `packages/backend/server/src/plugins/copilot/providers/provider-registry.ts` / `factory.ts` (profile resolution order)
- `packages/backend/server/src/plugins/copilot/byok/service.ts` (confirms `baseURL` is passed through verbatim, no normalization)
- `deploy/README.md`, `railway-env.txt` (deployment/volume facts)
- `/agent/workspace/cdz-ai/index.mjs`, `/agent/workspace/cdz-ai/README.md` (the actual CDZ AI server source — confirms it only implements classic chat-completions, not the Responses API)

---

## 1. Config change point: aim the `openai` provider at CDZ AI `/v1`

### Where
Config lives in the on-disk `AppConfigSchema` (`copilot.providers.*`), defined
in `packages/backend/server/src/plugins/copilot/config.ts`. It is NOT read
from `railway-env.txt`'s `COPILOT_OPENAI_API_KEY` alone in this fork — that
env var only seeds `providers.openai.apiKey` via the legacy path; `baseURL`
and `oldApiStyle` are file-only fields with no env var equivalent, so they
must go in the JSON file.

**Exact file, per `deploy/README.md` line 62 and Railway volume mount
(`deploy/README.md` line 36):**
```
/root/.ClickDz Work/config/config.json
```
(mount path `/root/.ClickDz Work` on the Railway volume attached to the
server container; `config/config.json` under it is the live override file
merged over `deploy/config/config.json`'s defaults — see
`packages/backend/server/src/base/config/register.ts` line 218-219 for the
lookup order: `env.projectRoot/config.json`, then
`${homedir()}/.affine/config/config.json`, generalized to `.ClickDz Work` in
this fork).

### What to write
Two ways to wire it in, pick ONE (do not do both, or resolution order gets
confusing):

**Option A — reuse the singular legacy slot (simplest, matches how
`COPILOT_OPENAI_API_KEY` already flows today):**
```json
{
  "copilot": {
    "providers": {
      "openai": {
        "apiKey": "Bearer-token-value-only-no-prefix",
        "baseURL": "https://cdz-ai-production.up.railway.app/v1",
        "oldApiStyle": true
      }
    }
  }
}
```
- `apiKey` is used as the raw Bearer token value (the transport adds
  `Authorization: Bearer <apiKey>` itself — do not put the literal string
  `Bearer ` in this field).
- `baseURL` MUST include the trailing `/v1` — every existing default in
  `config.ts` follows this convention (`https://api.openai.com/v1`,
  `https://generativelanguage.googleapis.com/v1beta`,
  `https://api.anthropic.com/v1`), and `OpenAIProvider.createNativeConfig()`
  (`providers/openai.ts` line 68-73) strips a trailing `/v1` before handing
  `base_url` to the Rust native layer, which then re-appends the correct
  path (`/v1/chat/completions` for `openai_chat`, `/v1/responses` for
  `openai_responses`) itself. `byok/service.ts` line 606 confirms `baseURL`
  is otherwise passed through completely verbatim with zero normalization,
  so getting the trailing `/v1` right here is on us.
- **`"oldApiStyle": true` is not optional — it is required.** CDZ AI's real
  server (`/agent/workspace/cdz-ai/index.mjs`) only implements
  `POST /v1/chat/completions`; it has no `/v1/responses` route. Without
  `oldApiStyle: true`, `OpenAIProvider.resolveModelBackendKind()`
  (`providers/openai.ts` line 44-48) defaults to `openai_responses`, and
  every request will hit a route that doesn't exist on CDZ AI and 404.

This overwrites the SAME single `openai` slot used by the current
`COPILOT_OPENAI_API_KEY`-seeded default, so upstream real OpenAI access is
fully replaced — fine for this migration since CDZ AI is meant to be the
sole text-model backend, but note it also means the `gpt-image-1` DALL-E
image path in `clickdz-bridge.controller.ts` (`OPENAI_IMAGE_API_KEY`, a
separate env var, untouched) keeps hitting real `api.openai.com` directly —
that path is independent of this provider config and is out of scope here.

**Option B — add a named profile instead (keeps real OpenAI addressable
too, via provider-id model prefixing):**
```json
{
  "copilot": {
    "providers": {
      "profiles": [
        {
          "id": "cdz-ai",
          "type": "openai",
          "priority": 100,
          "enabled": true,
          "config": {
            "apiKey": "Bearer-token-value-only-no-prefix",
            "baseURL": "https://cdz-ai-production.up.railway.app/v1",
            "oldApiStyle": true
          }
        }
      ]
    }
  }
}
```
`provider-registry.ts`'s `mergeProfiles()` (line 126-149) merges explicit
`profiles[]` with the legacy singular slots by id, so this can coexist with
`providers.openai` unchanged (real OpenAI) — `provider-registry.ts` picks
the highest-`priority` profile whose `models` allowlist (if set) matches, or
falls through registry order otherwise. Recommend adding `"models"` here
scoped to exactly the cdz-* + raw ids this migration introduces (see
section 2), so CDZ AI is only ever selected for those model ids and never
silently swallows a real `gpt-5.x` request meant for OpenAI directly. This
is the safer, more surgical option and the one I'd recommend, since it
avoids collapsing the "openai" provider type down to a single physical
backend.

Recommendation: **use Option B** for anything beyond a quick proof-of-concept
— it's not meaningfully more work to write and it avoids a silent full
replacement of the `openai` provider type.

---

## 2. New model-registry entries for `cdz-*` ids

File: `packages/backend/native/src/llm/core/model_registry.rs`,
inside `custom_model_registry_variants()` (this is a Rust native module —
changing it requires a native rebuild, not a hot JSON reload; see risks in
section 5).

### Protocol/backend_kind to copy
CDZ AI speaks plain OpenAI chat-completions (confirmed: `index.mjs` line
451-466 builds a classic `{choices:[{message:{role,content}}]}` response,
no `output[]`/Responses-API shape). The closest existing pattern in the
registry file is the **`openai_responses` variants (lines 296-434)** for
`backend_kind`/`protocol`/`request_layer` naming style, EXCEPT they use
`request_layer: "responses"` which assumes the modern Responses API. Since
the actual wire protocol is chat-completions, do not literally copy those —
instead mirror the OpenAI shape but with the chat-completions kind that the
`openai.ts` provider produces when `oldApiStyle: true` is set
(`backend_kind: "openai_chat"`, confirmed by `providers/openai.ts` line
44-48). There is currently no `openai_chat` example variant already in this
file to copy verbatim (all existing OpenAI custom variants in this file are
`openai_responses`), so the new entries establish the pattern — using
`backend_kind: "openai_chat"` and `protocol: "openai_chat"` (parallel naming
to how `gemini`/`anthropic` variants name `protocol` identically to
`backend_kind`, e.g. lines 35-53 `backend_kind: "anthropic"`,
`protocol: "anthropic"`).

**Attachments**: reuse the existing `image_attachment` local defined at the
top of `custom_model_registry_variants()` (lines 15-19) — CDZ AI's vision
path only accepts image URLs into a separate describe hook
(`index.mjs` `flattenMessages()` lines 164-188, collects `image_url` parts),
not audio/file, so do NOT reuse `gemini_attachment` (image+audio+file) for
these entries even though some target models are Gemini underneath — the
capability being registered here is CDZ AI's HTTP-level contract, not the
underlying vendor's.

### Proposed new variants (insert after line 464, before the existing
`clickdz-council` gemini_api variant at line 468, or replace it — see
section 4)

```rust
// CDZ AI supermodels — real multi-vendor backend via CDZ AI's
// OpenAI-compatible /v1/chat/completions
variants.push(llm_adapter::core::ModelRegistryVariant {
  backend_kind: "openai_chat".to_string(),
  canonical_key: "cdz-ultra".to_string(),
  raw_model_id: "cdz-ultra".to_string(),
  display_name: Some("CDZ Ultra".to_string()),
  aliases: vec!["cdz-ultra".to_string()],
  legacy_aliases: None,
  capabilities: vec![llm_adapter::core::ModelCapability {
    input: vec!["text".to_string(), "image".to_string()],
    output: vec!["text".to_string(), "object".to_string()],
    attachments: Some(image_attachment.clone()),
    structured_attachments: None,
    default_for_output_type: None,
  }],
  protocol: Some("openai_chat".to_string()),
  request_layer: Some("chat_completions".to_string()),
  route_overrides: None,
  behavior_flags: None,
});

// repeat the same shape for: cdz-council, cdz-sage, cdz-architect,
// cdz-scholar, cdz-flash, cdz-polyglot (display_name per README.md
// descriptions: "CDZ Council", "CDZ Sage", "CDZ Architect", "CDZ Scholar",
// "CDZ Flash", "CDZ Polyglot")

// raw passthrough ids CDZ AI also serves directly (index.mjs PASSTHROUGH
// map, lines 91-100) — only register the ones not already present as a
// DIFFERENT backend_kind variant, to avoid an ambiguous-canonical error
// (see model_registry.rs test `should_reject_ambiguous_alias_without_backend`,
// lines 587-596): claude-opus-4-8 already exists at backend_kind "anthropic"
// (lines 35-53) — do NOT add a second "openai_chat" variant with the same
// canonical_key unless callers always pass an explicit backend_kind, which
// they do not here (resolveModelBackendKind is fixed per-provider). Same
// logic applies to gpt-5.5, gpt-5.4, gpt-5.4-mini (already openai_responses,
// lines 296-354) and gemini-3.5-flash (already gemini_api, lines 437-464).
// PRACTICAL CONCLUSION: do not register these raw ids as new openai_chat
// variants — resolve them by keeping their EXISTING registry entries and
// routing them to CDZ AI purely through the provider profile's model
// prefix/allowlist (section 1, Option B "models" list), not through new
// registry rows. Only cdz-* names need new rows because they don't exist
// anywhere else.
```

So the concrete new-row set is exactly the 7 `cdz-*` names, all
`backend_kind: "openai_chat"`, `protocol: "openai_chat"`,
`request_layer: "chat_completions"` — nothing else needs a new row. The raw
ids (`claude-opus-4-8`, `gemini-3.1-pro-preview` [NOTE: not yet in the
registry — see below], `gemini-3.5-flash`, `gpt-5.5`, `gpt-5.4`,
`gpt-5.4-mini`) resolve via their pre-existing entries at other backend
kinds; whichever provider profile is asked to serve them (real Anthropic
API vs CDZ AI's chat-completions passthrough) is a **provider selection**
question, not a **registry** question, given a raw model id can only carry
ONE canonical registry row per backend_kind and callers don't supply
`backend_kind` at prompt-authoring time.

**Gap found**: `gemini-3.1-pro-preview` (used in `models.ts`
`DEFAULT_COUNCIL_MEMBERS` and CDZ AI's own `PASSTHROUGH` map) has NO
registry entry anywhere in `model_registry.rs` today (only
`gemini-3.5-flash` and `gemini-3-flash-preview` exist as Gemini variants,
lines 437-518). If this id is ever sent to CDZ AI as a raw passthrough
model, it needs its own `gemini_api`-style row (copy the
`gemini-3.5-flash` block, lines 437-464, swap `canonical_key`/`raw_model_id`
to `gemini-3.1-pro-preview`) OR it needs to be added as an `openai_chat` row
scoped only to how CDZ AI serves it (since CDZ AI is the only thing calling
it as "gemini-3.1-pro-preview" — no direct Gemini API access to this exact
preview id is implied elsewhere in the repo). Recommend adding it as
`openai_chat` since its only current caller is CDZ AI.

---

## 3. `optionalModels` change on "Chat With AFFiNE AI"

File: `packages/backend/native/src/llm/assets/prompts/built-in.json`,
the `"Chat With AFFiNE AI"` prompt block (currently starts at line 733).

Current `model` (default): `"gemini-2.5-flash"` (line 735) — this is a
**quota-backed** default served through whatever registry/provider
combination the base AFFiNE quota system points at; changing it is a
bigger decision than this ticket (it changes the free-tier default for
every user, not just the model menu). Recommend leaving `model` as-is for
this migration and only touching `optionalModels`.

Current `optionalModels` (line 736-778) is a flat list of ~38 ids spanning
Gemini/Claude/OpenAI native ids plus `clickdz-council` at the top (line 737).

### Proposed change
Prepend the 7 `cdz-*` ids right after (or in place of) `clickdz-council`,
since they are the new user-facing menu entries:

```json
"optionalModels": [
  "cdz-ultra",
  "cdz-council",
  "cdz-sage",
  "cdz-architect",
  "cdz-scholar",
  "cdz-flash",
  "cdz-polyglot",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  ... (rest unchanged) ...
]
```

- **Drop `"clickdz-council"` from this list** once `cdz-council` is live and
  verified (section 4) — it becomes a redundant, weaker duplicate (Make-agent
  backed vs real-model backed) of the exact same concept under a new name.
  Don't drop it in the SAME deploy as adding the cdz-* rows; drop it as the
  last step of rollout (section 5) after `cdz-council` is confirmed working,
  so there's a fallback path if CDZ AI has an outage during cutover.
- **Which cdz model becomes the prompt's `model` default** (section
  `"config"` field, line 792 `"proModels": []`, is unrelated — that's the
  Pro-tier gating list, currently empty, meaning no model here is
  Pro-gated today): do not change `model` in this pass; if/when CDZ AI is
  trusted as the primary backend, `cdz-flash` is the natural default-model
  candidate (cheap, fast, mirrors why `gemini-2.5-flash` is the default
  today) rather than `cdz-ultra` (routing is opaque/nondeterministic per
  request, which is bad UX for a "default") or `cdz-council` (highest
  latency/cost, bad as an always-on default).
- Everything else in the prompt block (`config.tools`, `config.proModels`,
  `builtins`, `messages` system/user templates) is untouched by this
  migration — it operates one level above model selection.

---

## 4. Make-agent path and `clickdz-council` frontend decoration

Two independent things get partially obsoleted once `cdz-council` is a real
backend-served model rather than a Make.com-agent virtual model:

### A. The Make-agent chat path in `clickdz-bridge.controller.ts`
Today, `clickdz-council` resolves through the registry as a
`gemini_api`-protocol variant (`model_registry.rs` lines 468-489) whose
comment (line 466-467) says explicitly: "*ClickDz virtual models — Make-backed
through the proven Gemini-protocol bridge path (the bridge forwards the
requested model id to the Make agent)*". That means today's `clickdz-council`
traffic is actually flowing through the Gemini provider machinery, which
proxies to... it's not fully clear from the registry alone whether it lands
on `clickdz-bridge.controller.ts`'s `/v1/chat/completions` handler (which DOES
special-case nothing for `clickdz-council` specifically — its `MODELS` list,
lines 118-131, doesn't even include `clickdz-council`) or whether "the Make
agent" here means the Gemini provider's own request is silently rewritten
somewhere in the Gemini provider implementation not covered by this read
list. Flag this as **needs verification during implementation**, not
something this plan can resolve from the 4 read-only files alone.

What IS certain and in scope to delete/simplify once `cdz-council` (the new
CDZ-AI-backed name) is confirmed working end-to-end:
- `clickdz-bridge.controller.ts`'s `resolveAgentForRequest()` (lines
  226-250) and `runMakeAgent()` (lines 267-319) become dead code for chat
  IF no `optionalModels` entry still routes through this bridge controller.
  Given the bridge's own `MODELS` array (lines 118-131) never listed
  `clickdz-council`/`clickdz-ultra` in a way that maps 1:1 onto the AI
  sidebar's model ids (it lists `clickdz-ultra`, `clickdz-builder`,
  `clickdz-fast`, `clickdz-smart`, `clickdz-arabic` — a DIFFERENT id space,
  presumably used by the separate "ClickDz Builder / bolt.diy" external
  bridge, not the in-app AFFiNE AI sidebar), this controller may be almost
  entirely orthogonal to the in-app chat prompt's model menu already. **Do
  not delete anything here in this migration** until it's confirmed via
  runtime tracing (or code not in scope of the 4 read files) which of
  `clickdz-bridge.controller.ts`'s routes the in-app sidebar actually calls.
  The `MAKE_BUILDER_AGENT_ID`/`MAKE_CODE_AGENT_ID`/app-generation
  (`/api/v1/apps/generate`) and image-enhancement paths are unrelated to
  chat model selection and are explicitly out of scope regardless.
- What CAN be said confidently: if, after tracing, `clickdz-council` in the
  registry truly never touches this controller (i.e. the Gemini-protocol
  bridge mentioned in the registry comment resolves elsewhere, e.g. inside
  the Gemini provider's own base URL pointing at a Make webhook not shown in
  these 4 files), then `clickdz-bridge.controller.ts` is untouched by this
  entire migration and only the registry + prompt + frontend files change.

### B. `clickdz-council` frontend decoration in `models.ts`
This file (`packages/frontend/core/src/modules/ai-button/services/models.ts`)
implements council-mode entirely client-side as a **decoration on top of a
single virtual model id** — it is NOT itself calling 3 models; it's UI/state
management (`COUNCIL_MODEL_ID`, `COUNCIL_SEATS`, `DEFAULT_COUNCIL_MEMBERS`,
`getCouncilMembers`/`toggleCouncilMember`/`setCouncilMode`, lines 16-153) that
presumably feeds member-selection into whatever request payload eventually
reaches the backend, where (per the registry comment) the actual fan-out to
3 models + synthesis happens server-side today via Make.

Once `cdz-council` is a REAL backend model (server does its own internal
fan-out + synthesis inside `/agent/workspace/cdz-ai/index.mjs`'s
`runCouncil()`, confirmed lines 203-239 there — 3 real
`Promise.allSettled` calls to Claude/Gemini/GPT + a GPT-5.5 synthesis call,
fully self-contained), the CLIENT no longer needs to manage which 3 models
are in the council or send that as a parameter — CDZ AI's council membership
is fixed server-side (`Claude Opus 4.8 + Gemini 3.1 Pro + GPT-5.5`, hardcoded
in `index.mjs` `runCouncil()` `members` array, line 205-209 — not
user-configurable at all).

**What can be deleted/simplified in `models.ts` once `cdz-council` (backend)
replaces `clickdz-council` (Make virtual)**:
- `AI_COUNCIL_MEMBERS_KEY` state, `councilMembers`/`councilMembers$` signal
  plumbing (lines 13, 52-59, 74-80), `getCouncilMembers()` (lines 101-114),
  `toggleCouncilMember()` (lines 116-128) — all become dead if the UI no
  longer lets users pick which 3 models sit on the council, since CDZ AI's
  council composition is fixed. This is a real, user-visible feature
  reduction (today's council is configurable; CDZ AI's isn't) — call this
  out to product/design before deleting, don't just delete it as a
  "simplification."
- `DEFAULT_COUNCIL_MEMBERS` (lines 18-22) becomes unused once the above goes.
- `COUNCIL_MODEL_ID`/`COUNCIL_SEATS` constants (lines 16-17) likely still
  needed if anything else in the AI-button module checks
  `modelId === COUNCIL_MODEL_ID` for UI treatment (e.g. showing a
  "3 models answered" badge) — keep these, just point `COUNCIL_MODEL_ID` at
  `'cdz-council'` instead of `'clickdz-council'`.
- `setCouncilMode()` (lines 130-153) and the `sessionModes` map / session
  mode tracking (lines 91-99) likely stay — they're about UI state
  (council vs standard reply formatting), not about which 3 models are
  members, and probably still apply to `cdz-council`.
- `CLICKDZ_FALLBACK_MODELS` (lines 24-31) should get `clickdz-council` (line
  26) swapped to `cdz-council`, and the other three ClickDz-prefixed
  fallback ids (`clickdz-smart`, `clickdz-fast`, `clickdz-arabic`, lines
  25, 27-28) are a SEPARATE decision — those are outside the 7 cdz-* names
  in scope for this ticket and are presumably still Make-backed; leave them
  alone unless a follow-up ticket covers them too.

**Bottom line for section 4**: the registry-level "virtual model forwarded to
Make agent" plumbing for `clickdz-council` specifically becomes redundant and
should be retired (registry entry removed, per section 2's suggestion to
replace lines 468-489), but do NOT touch `clickdz-bridge.controller.ts` until
its actual call graph relative to the in-app AI sidebar is confirmed —
this plan cannot verify that from the 4 read-only files alone, and deleting
Make-agent code that's still load-bearing for `clickdz-builder`/other ids
would be a regression.

---

## 5. Risks and rollout order

### Risks
1. **`oldApiStyle: true` is easy to forget and fails silently as 404s**, not
   a clear "wrong config" error — the Rust native layer will just try
   `/v1/responses` against a server that doesn't have that route. Test this
   explicitly (section below) before trusting any other verification step.
2. **`model_registry.rs` is compiled native code (napi/Rust)** — adding
   `cdz-*` variants requires a native module rebuild + redeploy, not a hot
   config reload. This is a CODE change with a build/release cycle, unlike
   sections 1 and 3 which are pure config/JSON and can ship independently
   and faster. Sequence accordingly (see rollout order).
3. **Ambiguous canonical key errors**: the registry's own test suite
   (`model_registry.rs` lines 587-596) proves that registering the SAME
   `canonical_key` at two different `backend_kind`s without a caller-supplied
   `backend_kind` throws "Ambiguous canonical" at resolve time. This is why
   section 2 explicitly avoids re-registering `claude-opus-4-8` /
   `gpt-5.5` / `gemini-3.5-flash` etc. as new `openai_chat` rows — doing so
   would break EVERY existing caller of those ids across the whole app, not
   just the new cdz-ai path, the moment the resolve is invoked without an
   explicit backend hint.
4. **CDZ AI is a single external dependency for ALL model traffic** once
   cutover completes — no vendor diversity/failover at the transport level
   inside ClickDz Work itself (that failover, if any, now lives entirely
   inside CDZ AI's own `ultraRoute()`/Make webhook layer, opaque to this
   codebase). An outage of `cdz-ai-production.up.railway.app` or its
   upstream Make.com webhooks takes down chat entirely unless a fallback
   profile (real OpenAI, still configured under a different profile id per
   Option B) is left enabled with lower priority.
5. **`cdz-council` latency**: `runCouncil()` in `index.mjs` makes 3 parallel
   model calls + 1 synthesis call, each subject to `ENGINE_TIMEOUT_MS`
   (default 180000ms / 3 min per hook call). Total worst-case
   council latency could be several minutes if synthesis waits on all three
   before proceeding (it does — `Promise.allSettled` then a follow-up
   `askEngine` call, `index.mjs` lines 210-231). Confirm the copilot
   session/streaming timeout budget in ClickDz Work's request layer can
   tolerate this before exposing `cdz-council` broadly — no evidence in the
   4 read files of what that timeout is.
6. **Bearer token single point of trust**: CDZ AI's `authorized()`
   (`index.mjs` lines 130-135) is a flat list membership check on
   `CDZ_API_KEYS` — no per-key scoping/rate limits visible server-side.
   Treat the key placed in `config.json` as a full-access secret; don't
   reuse it anywhere client-visible (already satisfied by only ever putting
   it in the server-side `config.json`, never the frontend).
7. **Config file lives on a volume, not in git** — the exact JSON edit in
   section 1 needs to be applied by whoever has Railway volume/shell access
   (or via the admin UI if it exposes provider profile editing — not
   confirmed in the 4 read files; `packages/frontend/admin/src` was only
   grep'd for `baseURL`/`base_url` and returned no hits, suggesting the
   admin UI likely does NOT have a form for this and it's raw-JSON-only
   today). Budget for manual/scripted volume access, not a UI click.

### Step-by-step rollout order

1. **Add a fallback-safe provider profile first (Option B), do not touch
   `providers.openai`.** Edit
   `/root/.ClickDz Work/config/config.json` on the Railway volume, add the
   `profiles: [{ id: "cdz-ai", type: "openai", ... oldApiStyle: true,
   models: [...] }]` block from section 1, with an initial `models` array
   containing ONLY the raw passthrough ids that already have registry rows
   elsewhere (`claude-opus-4-8`, `gemini-3.5-flash`, `gpt-5.5`, `gpt-5.4`,
   `gpt-5.4-mini`) — this requires zero registry changes and is testable
   immediately. Restart/redeploy the server process to pick up the config
   (confirm whether this fork hot-reloads `config.json` or requires a
   process restart — not established by the 4 read files; assume restart
   required unless proven otherwise).
   - **Verify**: from a shell with network access to the deployed server,
     call the copilot chat action with `model: "gpt-5.5"` (or whichever
     raw id) and confirm the response text is genuinely GPT-5.5-flavored
     (not a Make-agent artifact) — cheapest possible smoke test, and it
     specifically exercises the `oldApiStyle`/`openai_chat` wiring end to
     end without needing any Rust rebuild.
2. **If step 1 works, add the native registry rows** (section 2's 7 `cdz-*`
   canonical keys, plus the `gemini-3.1-pro-preview` gap-fill row). Rebuild
   the native module, redeploy.
   - **Verify**: `cargo test` in `packages/backend/native` should pass the
     existing suite (`model_registry.rs` lines 570-771) plus add/run a new
     test mirroring `should_resolve_custom_gpt_55` (lines 746-757) for one
     of the new `cdz-*` ids to confirm `resolve` returns
     `backend_kind: "openai_chat"` as expected, before touching the running
     server.
3. **Extend the `cdz-ai` profile's `models` allowlist** to include the 7
   `cdz-*` ids now that they resolve in the registry. Re-verify each
   individually via the same chat-action smoke test as step 1, paying
   particular attention to `cdz-council` given its latency risk (item 5
   above) — test it with a generous client-side timeout first.
4. **Update `optionalModels`** in `built-in.json` (section 3) to surface the
   7 `cdz-*` ids in the menu, keeping `clickdz-council` in the list
   alongside `cdz-council` for this step (both visible, not yet removing
   anything) — this is a config-only, no-rebuild-needed change (assuming
   `built-in.json` is loaded at runtime rather than baked into the native
   binary; if it's actually bundled into the native asset pipeline, fold
   this into step 2's rebuild instead — not fully confirmed from the 4 read
   files whether `assets/prompts/built-in.json` is a runtime-read JSON or
   compiled into the native module via `include_str!` or similar; check the
   native build script before assuming a hot path).
5. **Update `models.ts`** (section 4B): point `COUNCIL_MODEL_ID` at
   `'cdz-council'`, update `CLICKDZ_FALLBACK_MODELS`. Ship this alongside
   step 4 since they're both purely additive/renaming and low risk.
6. **Soak** — run both `clickdz-council`/Make and `cdz-council`/CDZ-AI side
   by side for a defined window (recommend at least a few days of real
   traffic) to compare latency, failure rate, and output quality before
   removing anything.
7. **Only after the soak passes**: remove `"clickdz-council"` from
   `optionalModels` (section 3), remove the `clickdz-council` registry row
   (`model_registry.rs` lines 468-489, requires another native rebuild),
   and — ONLY once the Make-agent call-graph question from section 4A is
   answered and confirmed dead — trim
   `clickdz-bridge.controller.ts`/council-member-selection UI in
   `models.ts`. Do not batch this removal step with any of steps 1-5; treat
   it as its own deploy with its own rollback plan (keep the Make agent IDs
   and env vars configured/live even after code removal, for one more
   release, in case a fast revert is needed).
8. **Only as a final, separate, product-approved decision**: swap the
   prompt's default `model` (line 735 of `built-in.json`) from
   `gemini-2.5-flash` to a cdz-* id, and decide whether to fully retire the
   `providers.openai` legacy slot in favor of Option B profiles everywhere
   (i.e., stop routing anything through real `api.openai.com` at all). Both
   are policy decisions beyond "migrate AI to CDZ AI" and deserve their own
   sign-off.

---

## Executive Summary (6 lines)

1. Point a new `providers.profiles[]` entry (type `openai`, id e.g. `cdz-ai`) in `/root/.ClickDz Work/config/config.json` at `baseURL: "https://cdz-ai-production.up.railway.app/v1"` with `apiKey` = the Bearer token and **`oldApiStyle: true`** (mandatory — CDZ AI only speaks chat-completions, not the Responses API, or every request 404s).
2. Add 7 new `backend_kind: "openai_chat"` rows to `model_registry.rs` for `cdz-ultra/council/sage/architect/scholar/flash/polyglot`; do NOT re-register existing raw ids (`claude-opus-4-8`, `gpt-5.5`, etc.) under a second backend_kind — that throws "Ambiguous canonical" for every existing caller of those ids app-wide.
3. Prepend the 7 `cdz-*` ids to `optionalModels` in the "Chat With AFFiNE AI" prompt (`built-in.json`), keep `clickdz-council` alongside `cdz-council` during a soak period, then drop it once confirmed stable; leave the prompt's default `model` untouched for now.
4. `clickdz-council`'s registry row and its Make-agent fan-out become redundant once `cdz-council` does real 3-model fan-out + synthesis server-side inside CDZ AI itself — safe to retire the registry row and council-member-picker UI in `models.ts` (council composition is fixed server-side, not user-configurable, which is a feature reduction to flag to product) — but do NOT touch `clickdz-bridge.controller.ts` until it's confirmed (not verifiable from the 4 read-only files alone) whether the in-app AI sidebar actually calls it at all versus only the separate ClickDz Builder bridge.
5. Biggest risks: the registry change requires a native (Rust) rebuild + redeploy (not hot-reloadable like the JSON config), `cdz-council` latency can run into minutes (3 sequential-dependent model calls plus synthesis, each with up to a 3-minute timeout), and post-cutover CDZ AI becomes a single external dependency for all chat — keep a lower-priority real-OpenAI profile enabled as a fallback.
6. Rollout order: (1) wire the provider profile scoped only to already-registered raw ids and smoke-test end-to-end with zero registry changes, (2) add+rebuild the 7 registry rows and unit-test resolution, (3) widen the profile's model allowlist to the cdz-* ids and test each individually, (4) surface them in `optionalModels` and rename `COUNCIL_MODEL_ID` in `models.ts`, (5) soak both council paths side by side, (6) only then retire `clickdz-council` and any now-dead Make-agent code as its own separate, revertible deploy.
