# Engine Model Research

Research notes on the underlying model generation that powers the CDZ-branded engines. Specs pulled from current official documentation (platform docs + vendor announcement pages). Vendor and product names are intentionally omitted from the descriptive copy below — see citations at the bottom for sourcing.

---

## Engine 4.8 (powers CDZ Sage 4.8)

**spec:**
- Context window: 1,000,000 tokens (1M), served by default with no special access header required
- Max output: 128,000 tokens per request (up to 300,000 tokens on batch/async workloads with a beta flag)
- Modalities: text and image input, text output; vision support; multilingual
- Reasoning: adaptive thinking only (auto-decides per turn whether to reason before responding); does not support a manually-set extended-thinking token budget; effort defaults to "high" with optional "extra"/"max" tiers for harder tasks
- Speed tier: moderate latency standard; optional fast mode (research preview) delivers up to 2.5x output tokens/second at a premium rate
- Reliable knowledge cutoff: January 2026

**powers:**
- Holds a 1-million-token working set — entire codebases, contract sets, or research libraries — in memory at once
- Automatically calibrates how hard to "think" per request, so trivial asks return instantly and hard ones get deep deliberation
- Plans multi-step work, catches its own mistakes mid-task, and sustains long unattended work sessions
- Flags its own uncertainty rather than confidently overstating progress — measurably fewer unflagged errors slipping through
- Mid-task instruction updates without restarting or breaking cached context, useful for long-running automated workflows
- Built for production-grade software engineering, multi-tool agent orchestration, and high-stakes enterprise deliverables

**blurb:** This is the engine for work where the stakes are real and the task doesn't fit in a single sitting — refactor a legacy codebase, run a multi-day research project, or orchestrate a fleet of sub-tasks without losing the thread. It thinks exactly as hard as each moment requires, then tells you honestly what it's still unsure about.

---

## Engine 4.6

**spec:**
- Context window: 1,000,000 tokens (1M), standard on the primary API surface
- Max output: 128,000 tokens per request (per official platform overview table; independent trackers cite 64k standard / 300k batch — treat 128k as the primary-source figure)
- Modalities: text and image input, text output; vision support; multilingual
- Reasoning: supports both adaptive thinking and manually-configured extended thinking; strong performance even with thinking off
- Speed tier: fast — the "best combination of speed and intelligence" tier, positioned between the flagship and the fastest model
- Reliable knowledge cutoff: January 2026

**powers:**
- Fits entire codebases, lengthy contracts, or dozens of research papers into a single request and reasons coherently across all of it
- Delivers near-flagship-tier output quality at real-time speed and lower cost
- Major leg-up in computer-use tasks — navigating spreadsheets, multi-step web forms, and cross-tab workflows the way a person would
- Long-horizon planning and simulated business/agent benchmarks show materially better sustained performance over time
- Compresses what used to be multi-day coding projects into hours of turnaround
- Strong resistance to hidden/injected instructions encountered during autonomous browsing or tool use

**blurb:** Built for the everyday grind of production work — coding, computer use, and knowledge tasks — at a speed that keeps pace with how fast your team moves. It carries a million tokens of context and still reasons sharply across every one of them, so nothing gets lost between the first message and the fiftieth.

---

## Engine 4.5-fast

**spec:**
- Context window: 200,000 tokens
- Max output: 64,000 tokens per request
- Modalities: text and image input, text output; vision support; multilingual
- Reasoning: supports extended thinking (no adaptive-thinking mode); trained to be explicitly context-aware of its remaining token budget so it paces itself instead of cutting corners
- Speed tier: fastest tier available — built for real-time and high-volume workloads
- Reliable knowledge cutoff: February 2025 (training data through July 2025)

**powers:**
- Runs 4-5x faster than the mid tier while matching its coding and agentic quality on most tasks
- 73.3% on a leading verified software-engineering benchmark — competitive with far larger, slower models
- Purpose-built for parallelized sub-agents: fan out dozens of workers on refactors, migrations, or research synthesis simultaneously
- Tracks its own remaining context budget in real time to avoid premature or incomplete answers
- Cheap and fast enough to sit behind free-tier products without compromising response quality
- Ideal for latency-critical, always-on experiences: live chat, customer support, real-time monitoring

**blurb:** The engine for scale — when you need frontier-level intelligence running underneath thousands of simultaneous conversations, sub-agents, or monitoring streams without blowing the budget or the clock. It's fast enough to power your busiest, most latency-sensitive product surface and still hold its own on hard technical work.

---

## Sources

- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8
- https://platform.claude.com/docs/en/build-with-claude/context-windows
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8
- https://www.anthropic.com/news/claude-opus-4-8
- https://www.anthropic.com/news/claude-sonnet-4-6
- https://www.anthropic.com/claude/opus
- https://www.anthropic.com/claude/sonnet
- https://www.anthropic.com/claude/haiku
- https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-8.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html

Note: the official platform overview table (docs.claude.com/en/about-claude/models/overview) is the primary source of truth for the numeric spec table and was cross-checked against each model's individual announcement/product page. Where a third-party or cached secondary source (e.g. AWS Bedrock model card, community explainer sites) gave a conflicting number, the primary vendor docs table value was used and the discrepancy is noted inline above rather than silently resolved.
