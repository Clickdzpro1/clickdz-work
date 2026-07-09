# Model Research: Engine 3.1 Pro & Engine 3.5 Flash

## Engine 3.1 Pro (powers CDZ Scholar 3.1)

- **spec:**
  - Context window: 1,048,576 tokens (~1M input)
  - Max output: 65,536 tokens
  - Modalities: Input — text, image, video, audio, PDF; Output — text only (no native image or audio generation)
  - Knowledge cutoff: January 2025
  - Speed tier: standard/premium reasoning tier (not the fast tier — optimized for depth over latency)

- **powers:**
  - Digests up to a million tokens of documents, codebases, or video in a single request
  - Runs multi-step agentic workflows with reliable, precise tool calling across real-world tasks
  - Reads and reasons over entire code repositories for software engineering tasks
  - Grounds answers in real-time search and maps data for factual accuracy
  - Executes code natively mid-reasoning to verify its own logic before responding
  - Sustains coherent, structured thinking across long, complex, multi-domain problems

- **blurb:** Engine 3.1 Pro is the flagship reasoning engine for work that can't afford to be wrong — built to hold an entire dataset, codebase, or document library in its head at once and reason through it with premium-grade depth. When the problem is genuinely hard and the stakes are high, this is the engine that gets called in.

## Engine 3.5 Flash (powers CDZ Flash 3.5)

- **spec:**
  - Context window: 1,048,576 tokens (~1M input)
  - Max output: 65,536 tokens
  - Modalities: Input — text, image, video, audio, PDF; Output — text only (no native image or audio generation)
  - Knowledge cutoff: January 2025 (latest model update: May 2026)
  - Speed tier: fast/high-throughput tier — built explicitly for low latency and high volume at near-premium quality

- **powers:**
  - Delivers near-flagship reasoning quality at a fraction of the cost and latency
  - Handles high-volume, parallel agentic execution across many sub-agents at once
  - Iterates through rapid, complex coding loops with pro-level coding proficiency
  - Sustains long-horizon, multi-step workflows and multi-week enterprise processes without losing the thread
  - Operates a computer interface directly (preview capability) to complete on-screen tasks
  - Scales cost-effectively across a million-token context for everyday, high-frequency use

- **blurb:** Engine 3.5 Flash is the workhorse built for scale — near-flagship intelligence tuned to run fast and cheap enough to power every routine task, not just the occasional hard one. It's the engine you deploy when you need serious reasoning at real-time speed and volume, from rapid coding iterations to swarms of parallel sub-agents working in the background.

---

## Sources

- https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview
- https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash
- https://ai.google.dev/gemini-api/docs/generate-content/gemini-3
- https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5
- https://deepmind.google/models/model-cards/gemini-3-1-pro/
- https://deepmind.google/models/model-cards/gemini-3-5-flash/
- https://deepmind.google/models/gemini/flash/
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/google-models
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/
