/**
 * CDZ AI — the ClickDz supermodel platform.
 *
 * One lean server, zero dependencies:
 *   - OpenAI-compatible API: GET /v1/models, POST /v1/chat/completions
 *     (streaming + non-streaming, multimodal image inputs)
 *   - Extras: POST /v1/audio/transcriptions, POST /v1/images/describe
 *   - MCP server (Streamable HTTP, JSON-RPC 2.0) at POST /mcp
 *
 * The model engine is a set of Make.com webhook scenarios (cdz-llm vendor
 * multiplexer, cdz-vision, cdz-audio, plus the existing OCR/search hooks),
 * which run real Claude / Gemini / GPT models on Make credits.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { assertPublicHttpUrl, normalizeMaxTokens, validateEngineFields } from './guards.mjs';
import { docsPage } from './docs.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- workers
// The ClickDz Workers catalog: 500+ specialist skills across 20 categories.
// Public (catalog data, not secret). Picker = categories w/o bodies; a
// worker's body is served as a system prompt by id.
const __dirCdz = dirname(fileURLToPath(import.meta.url));
let WORKERS = { categories: [], workers: {} };
try {
  WORKERS = JSON.parse(
    readFileSync(join(__dirCdz, 'workers.catalog.json'), 'utf8')
  );
} catch (e) {
  console.warn('[cdz-ai] workers catalog not loaded:', e?.message || e);
}
const WORKERS_PICKER = JSON.stringify({ categories: WORKERS.categories || [] });

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT || 8080);
const API_KEYS = (process.env.CDZ_API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);
const HOOKS = {
  llm: process.env.CDZ_LLM_WEBHOOK || '',
  vision: process.env.CDZ_VISION_WEBHOOK || '',
  audio: process.env.CDZ_AUDIO_WEBHOOK || '',
  ocr: process.env.CDZ_OCR_WEBHOOK || '',
  search: process.env.CDZ_SEARCH_WEBHOOK || '',
};
const ENGINE_TIMEOUT_MS = Number(process.env.CDZ_ENGINE_TIMEOUT_MS || 180000);

// ---- v4 unified Make engine (Path A: cdz-ai is a thin OpenAI<->Make bridge) ----
// When CDZ_ENGINE_MODE=v4, every capability routes to ONE Make webhook
// (feature-routed, {ok,result} envelope, x-make-apikey auth). Default 'legacy'
// keeps the classic per-hook behavior, so this ships DARK until the v4
// scenario is live and the mode is flipped.
const ENGINE_MODE = (process.env.CDZ_ENGINE_MODE || 'legacy').toLowerCase();
const ENGINE = {
  url: process.env.CDZ_ENGINE_WEBHOOK || '',
  key: process.env.CDZ_ENGINE_KEY || '',
};
const V4 = ENGINE_MODE === 'v4' && !!ENGINE.url;
const VENDOR2PROVIDER = { claude: 'anthropic', gpt: 'openai', gemini: 'gemini' };

// ------------------------------------------------------------ supermodels
/** vendor targets available through the cdz-llm multiplexer */
const V = {
  opus: { vendor: 'claude', model: 'claude-opus-4-8' },
  sonnet: { vendor: 'claude', model: 'claude-sonnet-4-6' },
  haiku: { vendor: 'claude', model: 'claude-haiku-4-5' },
  geminiPro: { vendor: 'gemini', model: 'gemini-3.1-pro-preview' },
  geminiFlash: { vendor: 'gemini', model: 'gemini-3.5-flash' },
  gpt55: { vendor: 'gpt', model: 'gpt-5.5' },
  gpt54: { vendor: 'gpt', model: 'gpt-5.4' },
  gpt54mini: { vendor: 'gpt', model: 'gpt-5.4-mini' },
};

const SUPERMODELS = {
  'cdz-ultra': {
    description:
      'The ClickDz flagship — smart-routes every request to the best real model (Claude, Gemini or GPT) automatically.',
    route: 'ultra',
  },
  'cdz-council': {
    description:
      'Three real frontier models — Claude Opus 4.8, Gemini 3.1 Pro and GPT-5.5 — answer in parallel, then a synthesis reconciles them.',
    route: 'council',
  },
  'cdz-sage': {
    target: V.opus,
    description: 'Deep reasoning and nuance (Claude Opus 4.8).',
    system:
      'You are CDZ Sage: a deep, careful thinker. Reason rigorously, surface hidden assumptions and risks, quantify confidence, and give a clear verdict. Prefer depth over breadth; never pad.',
  },
  'cdz-architect': {
    target: V.gpt55,
    description: 'Code, systems and step-by-step builds (GPT-5.5).',
    system:
      'You are CDZ Architect: an elite software engineer. Produce correct, complete, production-quality code and precise technical plans. State key decisions and tradeoffs in one line each. No filler.',
  },
  'cdz-scholar': {
    target: V.geminiPro,
    description: 'Research, structure and long documents (Gemini 3.1 Pro).',
    system:
      'You are CDZ Scholar: a structured researcher. Organize answers with crisp headings, tables where useful, and factual precision. Separate facts from inference explicitly.',
  },
  'cdz-flash': {
    target: V.geminiFlash,
    description: 'Instant answers for everyday questions (Gemini 3.5 Flash).',
    system:
      'You are CDZ Flash: fast and to the point. Answer in as few words as full correctness allows.',
  },
  'cdz-polyglot': {
    target: V.gpt54,
    description: 'Arabic, French and English mastery, Algeria-aware (GPT-5.4).',
    system:
      'You are CDZ Polyglot: a native-level Arabic (incl. Algerian Darija), French and English assistant. Always answer in the language of the question; keep numbers/currency in DZD context when relevant.',
  },
};

/** direct passthrough model ids -> engine targets */
const PASSTHROUGH = {
  'claude-opus-4-8': V.opus,
  'claude-sonnet-4-6': V.sonnet,
  'claude-haiku-4-5': V.haiku,
  'gemini-3.1-pro-preview': V.geminiPro,
  'gemini-3.5-flash': V.geminiFlash,
  'gpt-5.5': V.gpt55,
  'gpt-5.4': V.gpt54,
  'gpt-5.4-mini': V.gpt54mini,
};

// --------------------------------------------------------------- helpers
const usage = { requests: 0, engineCalls: 0, byModel: {} };

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

function err(res, status, message, type = 'invalid_request_error') {
  json(res, status, { error: { message, type } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 2_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!API_KEYS.length) return false; // keys required — no keys, no service
  const h = String(req.headers.authorization || '');
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return API_KEYS.includes(key);
}

/**
 * OpenAI `response_format` support: when a client requests JSON output,
 * append a strict output contract so the engine models return raw JSON,
 * and post-process the answer (strip markdown fences / surrounding prose).
 */
function jsonContractMessage(responseFormat) {
  if (
    !responseFormat ||
    (responseFormat.type !== 'json_object' &&
      responseFormat.type !== 'json_schema')
  ) {
    return null;
  }
  const schema = responseFormat.json_schema?.schema
    ? JSON.stringify(responseFormat.json_schema.schema)
    : '';
  return {
    role: 'system',
    content:
      'CRITICAL OUTPUT CONTRACT: Respond with ONLY a single valid JSON ' +
      (schema
        ? `document that strictly conforms to this JSON Schema:\n${schema}`
        : 'object') +
      '\nNo markdown fences, no commentary, no text before or after the JSON.',
  };
}

/** best-effort extraction of a JSON document from a model answer */
function extractJsonAnswer(text) {
  const raw = String(text || '').trim();
  const tryParse = s => {
    try {
      JSON.parse(s);
      return s;
    } catch {
      return null;
    }
  };
  if (tryParse(raw)) return raw;
  // ```json fenced block
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = fence[1].trim();
    if (tryParse(inner)) return inner;
  }
  // first balanced {...} or [...] slice
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = raw.indexOf(open);
    const end = raw.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const slice = raw.slice(start, end + 1);
      if (tryParse(slice)) return slice;
    }
  }
  return raw; // let the caller's validator report the failure
}

async function callHook(url, payload, timeoutMs = ENGINE_TIMEOUT_MS) {
  usage.engineCalls++;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const trimmed = text.trim();
  // "Accepted" is Make's default webhook ack when a scenario is off or its
  // webhook isn't in immediate-response mode — treat it as a failure, never
  // as a real answer (this silently poisoned vision/OCR before).
  if (!res.ok || /^Scenario failed/i.test(trimmed) || trimmed === 'Accepted') {
    throw new Error(`engine error: ${(trimmed || res.statusText).slice(0, 200)}`);
  }
  return trimmed;
}

/**
 * Salvage the value from a legacy ALMOST-JSON Make envelope. The repaired v4
 * scenario emits typed JSON, but this defensive fallback protects rollbacks or
 * stale scenario revisions from leaking a raw envelope into chat.
 */
function salvageEnvelope(raw) {
  const key = raw.match(/"(?:result|answer|description|text)"\s*:\s*"/);
  if (!key) return null;
  const start = key.index + key[0].length;
  let end = -1;
  for (const marker of [
    '","model_label"', '", "model_label"',
    '","scenario_version"', '", "scenario_version"',
    '","session_id"', '", "session_id"',
    '","confidence"', '","page"', '","duration_seconds"',
  ]) {
    const i = raw.indexOf(marker, start);
    if (i !== -1 && (end === -1 || i < end)) end = i;
  }
  if (end === -1) {
    const t = raw.lastIndexOf('"}');
    end = t > start ? t : -1;
  }
  if (end <= start) return null;
  return raw
    .slice(start, end)
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    .trim();
}

/** call the unified v4 Make engine for one feature; returns the result text */
async function callEngine(feature, fields, timeoutMs = ENGINE_TIMEOUT_MS) {
  usage.engineCalls++;
  const validatedFields = validateEngineFields(feature, fields);
  const res = await fetch(ENGINE.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-make-apikey': ENGINE.key },
    body: JSON.stringify({
      feature,
      session_id: randomUUID(),
      ...validatedFields,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const trimmed = (await res.text()).trim();
  if (trimmed === 'Accepted') {
    throw new Error('engine not active: Make returned "Accepted" (scenario off or webhook not immediate-response)');
  }
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Defensive rollback compatibility: salvage legacy string-interpolated
    // envelopes instead of leaking the raw wrapper into chat.
    const salvaged = salvageEnvelope(trimmed);
    if (salvaged) return salvaged;
    if (!res.ok) throw new Error(`engine error ${res.status}: ${trimmed.slice(0, 160)}`);
    return trimmed; // tolerate a genuine raw-text response
  }
  if (data.ok === false) {
    throw new Error(`engine ${data.error_code || 'error'}: ${data.message || 'failed'}`);
  }
  const out = data.result ?? data.answer ?? data.description ?? data.text ?? '';
  return typeof out === 'string' ? out : JSON.stringify(out);
}

/** map a cdz vendor target + persona to the v4 engine's feature:chat */
function engineChat(target, system, prompt, maxTokens = 4000) {
  return callEngine('chat', {
    model_provider: VENDOR2PROVIDER[target.vendor] || 'openai',
    model: target.model,
    message: prompt,
    max_tokens: normalizeMaxTokens(maxTokens),
    skill_enabled: !!system,
    skill_context: system || '',
  });
}

/** call the chat engine for one vendor target (v4 unified, or legacy cdz-llm) */
function askEngine(target, system, prompt, maxTokens = 4000) {
  if (V4) return engineChat(target, system, prompt, maxTokens);
  return callHook(HOOKS.llm, {
    vendor: target.vendor,
    model: target.model,
    system: system || 'You are a helpful assistant.',
    prompt,
    max_tokens: String(maxTokens),
  });
}

/** flatten OpenAI messages -> {system, prompt, imageUrls} */
function flattenMessages(messages) {
  const systems = [];
  const turns = [];
  const imageUrls = [];
  for (const m of messages || []) {
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === 'text') text += (text ? '\n' : '') + part.text;
        if (part?.type === 'image_url') {
          const u = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          if (u && /^https?:\/\//.test(u)) imageUrls.push(u);
        }
      }
    }
    if (m.role === 'system') systems.push(text);
    else turns.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
  }
  return {
    system: systems.join('\n'),
    prompt: turns.join('\n\n'),
    imageUrls: imageUrls.slice(0, 3),
  };
}

/** ultra router: pick the best vendor for the request */
function ultraRoute(prompt) {
  const p = prompt || '';
  if (/[؀-ۿ]/.test(p)) return { ...V.gpt54, persona: SUPERMODELS['cdz-polyglot'].system };
  if (/```|\bfunction\b|\bimport\b|\bclass\b|\bAPI\b|\bcode\b|\bbug\b|\bdeploy\b|\bSQL\b/i.test(p))
    return { ...V.gpt55, persona: SUPERMODELS['cdz-architect'].system };
  if (/\banalyze\b|\bwhy\b|\bshould (i|we)\b|\brisk\b|\bdecide\b|\bstrategy\b|\bethic/i.test(p) || p.length > 1200)
    return { ...V.opus, persona: SUPERMODELS['cdz-sage'].system };
  if (/\breport\b|\bcompare\b|\btable\b|\bresearch\b|\bplan\b|\boutline\b/i.test(p))
    return { ...V.geminiPro, persona: SUPERMODELS['cdz-scholar'].system };
  return { ...V.geminiFlash, persona: SUPERMODELS['cdz-flash'].system };
}

/** real multi-vendor council */
async function runCouncil(system, prompt) {
  const members = [
    { name: 'Claude Opus 4.8', target: V.opus, style: 'depth, nuance, caveats and second-order effects' },
    { name: 'Gemini 3.1 Pro', target: V.geminiPro, style: 'structure, data and breadth' },
    { name: 'GPT-5.5', target: V.gpt55, style: 'precision, pragmatism and concrete next steps' },
  ];
  const results = await Promise.allSettled(
    members.map(m =>
      askEngine(
        m.target,
        `${system ? system + '\n' : ''}You are the ${m.name} member of the ClickDz Council. Answer with ${m.style}. Be genuinely yourself — do not imitate the other members. Under 160 words.`,
        prompt,
        1200
      )
    )
  );
  const sections = members.map((m, i) => ({
    name: m.name,
    text: results[i].status === 'fulfilled' ? results[i].value : `(unavailable: ${results[i].reason?.message || 'error'})`,
  }));
  let synthesis = '';
  try {
    synthesis = await askEngine(
      V.gpt55,
      'You are the ClickDz Council synthesizer. Reconcile the three member answers into one verdict. Open with a single bold verdict line (markdown), then the reasoning and concrete next steps. Under 180 words. Do not repeat the members verbatim.',
      `Question: ${prompt}\n\n${sections.map(s => `### ${s.name}\n${s.text}`).join('\n\n')}`,
      900
    );
  } catch (e) {
    synthesis = '(synthesis unavailable)';
  }
  return (
    sections.map(s => `### ${s.name}\n${s.text}`).join('\n\n') +
    `\n\n### ⚖️ Council synthesis\n${synthesis}`
  );
}

/** resolve a chat request to final answer text */
async function completeChat(model, messages, maxTokens) {
  const { system, prompt, imageUrls } = flattenMessages(messages);
  const safeImageUrls = imageUrls.map(url =>
    assertPublicHttpUrl(url, 'image_url')
  );
  let visionContext = '';
  if (safeImageUrls.length && (V4 ? ENGINE.url : HOOKS.vision)) {
    const describe = u => V4
      ? callEngine('ocr_describe', { file_url: u, model_provider: 'gemini' }, 60000)
      : callHook(HOOKS.vision, { image_url: u, prompt: 'Describe this image precisely and completely.' }, 60000);
    const descriptions = await Promise.allSettled(safeImageUrls.map(describe));
    visionContext = descriptions
      .map((d, i) => (d.status === 'fulfilled' ? `[Attached image ${i + 1}]: ${d.value}` : ''))
      .filter(Boolean)
      .join('\n');
  }
  const fullPrompt = visionContext ? `${visionContext}\n\n${prompt}` : prompt;

  const sm = SUPERMODELS[model];
  if (sm?.route === 'council') return runCouncil(system, fullPrompt);
  if (sm?.route === 'ultra') {
    const route = ultraRoute(fullPrompt);
    return askEngine(route, [route.persona, system].filter(Boolean).join('\n'), fullPrompt, maxTokens);
  }
  if (sm?.target) {
    return askEngine(sm.target, [sm.system, system].filter(Boolean).join('\n'), fullPrompt, maxTokens);
  }
  const direct = PASSTHROUGH[model];
  if (direct) return askEngine(direct, system, fullPrompt, maxTokens);
  throw Object.assign(new Error(`Unknown model: ${model}`), { status: 404 });
}

/** stream text as OpenAI SSE chunks with a lively pace */
function streamAnswer(res, model, text) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const id = `chatcmpl-cdz-${Date.now()}`;
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  const chunks = text.match(/[\s\S]{1,60}/g) || [''];
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      send({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: { content: chunks[i++] }, finish_reason: null }] });
      setTimeout(tick, 18);
    } else {
      send({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  tick();
}

const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------- MCP
const MCP_TOOLS = [
  {
    name: 'cdz_ask',
    description:
      'Ask any CDZ supermodel or raw frontier model (Claude/Gemini/GPT). Models: cdz-ultra, cdz-council, cdz-sage, cdz-architect, cdz-scholar, cdz-flash, cdz-polyglot, or direct ids like claude-opus-4-8 / gemini-3.1-pro-preview / gpt-5.5.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id (default cdz-ultra)' },
        prompt: { type: 'string', description: 'The question or task' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'cdz_council',
    description: 'Convene the ClickDz Council: Claude Opus 4.8 + Gemini 3.1 Pro + GPT-5.5 answer in parallel with a final synthesis.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'cdz_describe_image',
    description: 'Describe an image from a public URL (vision on Make credits).',
    inputSchema: {
      type: 'object',
      properties: { image_url: { type: 'string' }, prompt: { type: 'string' } },
      required: ['image_url'],
    },
  },
  {
    name: 'cdz_transcribe_audio',
    description: 'Transcribe an audio file from a public URL.',
    inputSchema: { type: 'object', properties: { file_url: { type: 'string' } }, required: ['file_url'] },
  },
  {
    name: 'cdz_ocr',
    description: 'Extract verbatim text from an image/document at a public URL.',
    inputSchema: { type: 'object', properties: { file_url: { type: 'string' } }, required: ['file_url'] },
  },
  {
    name: 'cdz_web_search',
    description: 'Grounded web search with cited answer.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

async function mcpToolCall(name, args) {
  switch (name) {
    case 'cdz_ask':
      return completeChat(args.model || 'cdz-ultra', [{ role: 'user', content: args.prompt }], 4000);
    case 'cdz_council':
      return runCouncil('', args.question);
    case 'cdz_describe_image': {
      const imageUrl = assertPublicHttpUrl(args.image_url, 'image_url');
      return V4
        ? callEngine('ocr_describe', { file_url: imageUrl, model_provider: 'gemini' }, 60000)
        : callHook(HOOKS.vision, { image_url: imageUrl, prompt: args.prompt || 'Describe this image precisely.' }, 60000);
    }
    case 'cdz_transcribe_audio': {
      const fileUrl = assertPublicHttpUrl(args.file_url, 'file_url');
      return V4
        ? callEngine('ocr_audio', { file_url: fileUrl }, 120000)
        : callHook(HOOKS.audio, { file_url: fileUrl }, 120000);
    }
    case 'cdz_ocr': {
      const fileUrl = assertPublicHttpUrl(args.file_url, 'file_url');
      if (V4) return callEngine('ocr_extract_text', { image_url: fileUrl }, 60000);
      const raw = await callHook(HOOKS.ocr, { file_url: fileUrl }, 60000);
      try { return JSON.parse(raw).text ?? raw; } catch { return raw; }
    }
    case 'cdz_web_search': {
      const raw = await callHook(HOOKS.search, { query: args.query }, 60000);
      try { return JSON.parse(raw).answer ?? raw; } catch { return raw; }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMcp(req, res, body) {
  let rpc;
  try { rpc = JSON.parse(body); } catch { return err(res, 400, 'invalid JSON'); }
  const reply = (result, error) =>
    json(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, ...(error ? { error } : { result }) });

  switch (rpc.method) {
    case 'initialize':
      return reply({
        protocolVersion: rpc.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'cdz-ai', version: '1.0.0' },
      });
    case 'notifications/initialized':
      res.writeHead(202).end();
      return;
    case 'tools/list':
      return reply({ tools: MCP_TOOLS });
    case 'tools/call': {
      try {
        const text = await mcpToolCall(rpc.params?.name, rpc.params?.arguments || {});
        return reply({ content: [{ type: 'text', text: String(text) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    case 'ping':
      return reply({});
    default:
      return reply(null, { code: -32601, message: `Method not found: ${rpc.method}` });
  }
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if ((path === '/' || path === '/docs') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(docsPage(req.headers.host || 'api.clickdz.ai'));
  }

  // ---- Workers catalog (public) ----
  if (path === '/v1/workers' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });
    return res.end(WORKERS_PICKER);
  }
  if (path.startsWith('/v1/workers/') && req.method === 'GET') {
    const id = decodeURIComponent(path.slice('/v1/workers/'.length));
    const system = WORKERS.workers?.[id];
    if (!system) return err(res, 404, `Unknown worker: ${id}`);
    return json(res, 200, { id, system });
  }

  if (path === '/v1' && req.method === 'GET') {
    return json(res, 200, {
      name: 'CDZ AI',
      tagline: 'The ClickDz supermodel platform — real Claude, Gemini and GPT behind one API.',
      endpoints: ['/v1/models', '/v1/chat/completions', '/v1/audio/transcriptions', '/v1/images/describe', '/mcp'],
      docs: 'OpenAI-compatible. Authorization: Bearer <key>.',
    });
  }

  if (!authorized(req)) return err(res, 401, 'Missing or invalid API key', 'authentication_error');
  usage.requests++;

  try {
    if (path === '/v1/models' && req.method === 'GET') {
      const models = [
        ...Object.entries(SUPERMODELS).map(([id, m]) => ({ id, object: 'model', created: now(), owned_by: 'clickdz', description: m.description })),
        ...Object.keys(PASSTHROUGH).map(id => ({ id, object: 'model', created: now(), owned_by: 'clickdz-engine' })),
      ];
      return json(res, 200, { object: 'list', data: models });
    }

    if (path === '/v1/usage' && req.method === 'GET') {
      return json(res, 200, usage);
    }

    const body = req.method === 'POST' ? await readBody(req) : '';

    if (path === '/mcp' && req.method === 'POST') {
      return handleMcp(req, res, body);
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const parsed = JSON.parse(body || '{}');
      const model = parsed.model || 'cdz-ultra';
      usage.byModel[model] = (usage.byModel[model] || 0) + 1;
      const maxTokens = normalizeMaxTokens(parsed.max_tokens);
      // structured output: enforce the JSON contract + clean the answer
      const contract = jsonContractMessage(parsed.response_format);
      const messages = contract
        ? [...(parsed.messages || []), contract]
        : parsed.messages || [];
      let text = await completeChat(model, messages, maxTokens);
      if (contract) text = extractJsonAnswer(text);
      if (parsed.stream) return streamAnswer(res, model, text);
      return json(res, 200, {
        id: `chatcmpl-cdz-${Date.now()}`,
        object: 'chat.completion',
        created: now(),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    if (path === '/v1/images/describe' && req.method === 'POST') {
      const { image_url, prompt } = JSON.parse(body || '{}');
      const imageUrl = assertPublicHttpUrl(image_url, 'image_url');
      const description = V4
        ? await callEngine('ocr_describe', { file_url: imageUrl, model_provider: 'gemini' }, 60000)
        : await callHook(HOOKS.vision, { image_url: imageUrl, prompt: prompt || 'Describe this image precisely.' }, 60000);
      return json(res, 200, { description });
    }

    if (path === '/v1/audio/transcriptions' && req.method === 'POST') {
      const { file_url } = JSON.parse(body || '{}');
      const fileUrl = assertPublicHttpUrl(file_url, 'file_url');
      const text = V4
        ? await callEngine('ocr_audio', { file_url: fileUrl }, 120000)
        : await callHook(HOOKS.audio, { file_url: fileUrl }, 120000);
      return json(res, 200, { text });
    }

    return err(res, 404, `No route: ${req.method} ${path}`);
  } catch (e) {
    return err(res, e.status || 502, e.message || 'engine failure', 'api_error');
  }
});

server.listen(PORT, () => {
  console.log(`[cdz-ai] listening on :${PORT} — keys:${API_KEYS.length} engine:${V4 ? 'v4' : 'legacy'} llm:${!!HOOKS.llm} vision:${!!HOOKS.vision} audio:${!!HOOKS.audio}`);
});
