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

async function callHook(url, payload, timeoutMs = ENGINE_TIMEOUT_MS) {
  usage.engineCalls++;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok || /^Scenario failed/i.test(text)) {
    throw new Error(`engine error: ${text.slice(0, 200)}`);
  }
  return text.trim();
}

/** call the cdz-llm multiplexer for one vendor target */
function askEngine(target, system, prompt, maxTokens = 4000) {
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
  let visionContext = '';
  if (imageUrls.length && HOOKS.vision) {
    const descriptions = await Promise.allSettled(
      imageUrls.map(u => callHook(HOOKS.vision, { image_url: u, prompt: 'Describe this image precisely and completely.' }, 60000))
    );
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
    case 'cdz_describe_image':
      return callHook(HOOKS.vision, { image_url: args.image_url, prompt: args.prompt || 'Describe this image precisely.' }, 60000);
    case 'cdz_transcribe_audio':
      return callHook(HOOKS.audio, { file_url: args.file_url }, 120000);
    case 'cdz_ocr': {
      const raw = await callHook(HOOKS.ocr, { file_url: args.file_url }, 60000);
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
      const maxTokens = Math.min(Number(parsed.max_tokens) || 4000, 16000);
      const text = await completeChat(model, parsed.messages || [], maxTokens);
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
      if (!image_url) return err(res, 400, 'image_url required');
      const description = await callHook(HOOKS.vision, { image_url, prompt: prompt || 'Describe this image precisely.' }, 60000);
      return json(res, 200, { description });
    }

    if (path === '/v1/audio/transcriptions' && req.method === 'POST') {
      const { file_url } = JSON.parse(body || '{}');
      if (!file_url) return err(res, 400, 'file_url required (public URL)');
      const text = await callHook(HOOKS.audio, { file_url }, 120000);
      return json(res, 200, { text });
    }

    return err(res, 404, `No route: ${req.method} ${path}`);
  } catch (e) {
    return err(res, e.status || 502, e.message || 'engine failure', 'api_error');
  }
});

server.listen(PORT, () => {
  console.log(`[cdz-ai] listening on :${PORT} — keys:${API_KEYS.length} llm:${!!HOOKS.llm} vision:${!!HOOKS.vision} audio:${!!HOOKS.audio}`);
});
