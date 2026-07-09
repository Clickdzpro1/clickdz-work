# CDZ AI

**The ClickDz supermodel platform** — real Claude, Gemini and GPT frontier models behind one OpenAI-compatible API and one MCP server, powered by the Make.com multi-vendor engine (Make credits, no vendor API bills).

## Endpoints

| Endpoint | What |
|---|---|
| `GET /v1/models` | Supermodels + raw engine models |
| `POST /v1/chat/completions` | OpenAI-compatible chat — streaming & non-streaming, multimodal (`image_url` parts described via vision engine) |
| `POST /v1/images/describe` | `{image_url, prompt?}` → description |
| `POST /v1/audio/transcriptions` | `{file_url}` → transcript |
| `POST /mcp` | MCP server (JSON-RPC 2.0): `cdz_ask`, `cdz_council`, `cdz_describe_image`, `cdz_transcribe_audio`, `cdz_ocr`, `cdz_web_search` |
| `GET /v1/usage` | Request counters |

Auth: `Authorization: Bearer <key>` — keys from `CDZ_API_KEYS` (comma-separated).

## Supermodels

- **cdz-ultra** — smart router: picks the best real vendor per request
- **cdz-council** — Claude Opus 4.8 + Gemini 3.1 Pro + GPT-5.5 in parallel + synthesis
- **cdz-sage** (Opus 4.8) · **cdz-architect** (GPT-5.5) · **cdz-scholar** (Gemini 3.1 Pro) · **cdz-flash** (Gemini 3.5 Flash) · **cdz-polyglot** (GPT-5.4, AR/FR/EN)
- Raw passthrough: `claude-opus-4-8`, `gemini-3.1-pro-preview`, `gpt-5.5`, …

## Env

```
CDZ_API_KEYS=key1,key2
CDZ_LLM_WEBHOOK=...      # Make cdz-llm vendor multiplexer
CDZ_VISION_WEBHOOK=...   # Make cdz-vision
CDZ_AUDIO_WEBHOOK=...    # Make cdz-audio
CDZ_OCR_WEBHOOK=...      # existing OCR scenario
CDZ_SEARCH_WEBHOOK=...   # existing web-search scenario
PORT=8080
```

Zero dependencies. `node index.mjs`.
