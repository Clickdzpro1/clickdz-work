import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

const MAKE_API_BASE = process.env.MAKE_API_BASE || 'https://eu1.make.com/api/v2';
const MAKE_API_KEY = process.env.MAKE_API_KEY || '';
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || '';
const MAKE_AGENT_ID = process.env.MAKE_SUPERAGENT_ID || process.env.MAKE_AGENT_ID || '';
const MAKE_ARABIC_AGENT_ID = process.env.MAKE_ARABIC_AGENT_ID || MAKE_AGENT_ID;
const OPENAI_IMAGE_API_KEY = process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const MAKE_OCR_WEBHOOK_URL = process.env.MAKE_OCR_WEBHOOK_URL || '';
const MAKE_CODE_AGENT_ID = process.env.MAKE_CODE_AGENT_ID || '';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';

// ClickDz Apps — models build single-file web apps, deployed to Vercel
const APP_BUILDER_GUIDELINES = [
  'You are ClickDz Apps, an elite front-end engineer. Build ONE complete,',
  'production-quality single-file web app for the request below.',
  'Rules:',
  '- Output ONLY the code, inside a single ```html code block. No commentary.',
  '- One self-contained index.html: inline <style> and <script>, vanilla JS.',
  '- No external network calls or CDNs (Google Fonts via <link> is allowed).',
  '- Beautiful and modern: thoughtful typography, generous spacing, a coherent',
  '  palette that works on dark screens, subtle motion and hover states.',
  '- Fully functional interactivity; use localStorage when persistence helps.',
  '- Accessible (semantic HTML, labels, contrast) and responsive mobile-first.',
  '- If the request is in Arabic, build the interface right-to-left (dir="rtl").',
].join('\n');

const CLICKDZ_APP_WATERMARK =
  '<div style="position:fixed;bottom:10px;right:12px;font:600 11px system-ui;opacity:.55;z-index:99999"><a href="https://work.clickdz.ai" style="color:inherit;text-decoration:none" target="_blank" rel="noopener">⚡ Built with ClickDz</a></div>';

function slugifyAppName(input: string): string {
  const base = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-|-$/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${rand}` : `app-${rand}`;
}

function extractHtmlApp(reply: string): string {
  const block = reply.match(/```html\s*([\s\S]*?)```/i)?.[1];
  const candidate = (block ?? reply).trim();
  if (/^<!doctype html/i.test(candidate) || /^<html[\s>]/i.test(candidate)) {
    return candidate;
  }
  return '';
}

// ClickDz 1.0 — the smart image model: Make-enhanced prompt -> gpt-image-1
const CLICKDZ_IMAGE_MODEL_IDS = new Set(['clickdz-image-1.0', 'clickdz-image']);
const CLICKDZ_IMAGE_ENGINE = 'gpt-image-1';
const IMAGE_ENHANCER_GUIDELINES = [
  'You are ClickDz 1.0, an elite image prompt engineer. Rewrite the request',
  'below into ONE masterful English image-generation prompt.',
  'Rules:',
  '- preserve the user intent and every explicit detail they gave',
  '- specify: subject, setting, composition (framing, perspective), lighting',
  '  (quality, direction, mood), color palette, style or medium, fine textures',
  '- add tasteful photographic/artistic vocabulary (lens, film stock, render',
  '  style) only when it fits the request',
  '- if the request is Arabic or French, translate the intent faithfully into',
  '  English, but keep any text that must appear INSIDE the image in its',
  '  original language, wrapped in double quotes',
  '- never invent brands, logos, real people or watermarks not requested',
  '- output ONLY the final prompt text, no commentary, at most 180 words',
].join('\n');

const MODELS = [
  'clickdz-fast',
  'clickdz-smart',
  'clickdz-arabic',
  'gpt-5.5',
  'gpt-5-mini',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  'dall-e-3',
];

function now() {
  return Math.floor(Date.now() / 1000);
}

function hasArabic(text: string) {
  return /[\u0600-\u06FF]/.test(text);
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

function normalizeMessages(messages: Array<{ role: string; content: unknown }>) {
  return (messages || []).map(message => ({
    role: message.role,
    content: flattenContent(message.content),
  }));
}

function openAIChatResponse(id: string, model: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: now(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function parseMakeAgentResponse(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.reply === 'string') return parsed.reply;
      if (typeof parsed.answer === 'string') return parsed.answer;
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.response === 'string') return parsed.response;
      return raw;
    } catch {
      return raw;
    }
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.reply === 'string') return obj.reply;
    if (typeof obj.answer === 'string') return obj.answer;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.response === 'string') return parseMakeAgentResponse(obj.response);
  }
  return '';
}

@Controller()
export class ClickDzBridgeController {
  private readonly logger = new Logger(ClickDzBridgeController.name);

  private assertMakeReady() {
    if (!MAKE_API_KEY || !MAKE_TEAM_ID || !MAKE_AGENT_ID) {
      throw new HttpException(
        {
          error: {
            message: 'Make.com AI agent is not configured',
            type: 'configuration_error',
            code: 'make_not_configured',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
  }

  private async runMakeAgent(
    messages: Array<{ role: string; content: string }>,
    model: string,
    agentIdOverride?: string
  ) {
    this.assertMakeReady();
    const joined = messages
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');
    const agentId =
      agentIdOverride ||
      (hasArabic(joined) || model.includes('arabic')
        ? MAKE_ARABIC_AGENT_ID
        : MAKE_AGENT_ID);
    const response = await fetch(
      `${MAKE_API_BASE}/ai-agents/v1/agents/${agentId}/run?teamId=${MAKE_TEAM_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${MAKE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: `You are ClickDz Work AI. Answer directly and helpfully. Requested model: ${model}.\n\n${joined}`,
            },
          ],
          config: {},
        }),
        // large code generations can take a couple of minutes — fail
        // controlled instead of hanging forever
        signal: AbortSignal.timeout(240000),
      }
    );

    if (!response.ok) {
      throw new HttpException(
        {
          error: {
            message: `Make.com agent failed: ${response.status} ${response.statusText}`,
            type: 'provider_error',
            code: 'make_agent_failed',
          },
        },
        HttpStatus.BAD_GATEWAY
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return parseMakeAgentResponse(data.response ?? data);
  }

  @Get(['/api/v1/models', '/v1/models'])
  models() {
    return {
      object: 'list',
      data: MODELS.map(id => ({
        id,
        object: 'model',
        created: now(),
        owned_by: id === 'dall-e-3' ? 'openai-images' : 'make.com',
      })),
    };
  }

  @Post(['/api/v1/chat/completions', '/v1/chat/completions'])
  async chatCompletions(@Body() body: any, @Res() res: Response) {
    const id = `chatcmpl_${Date.now()}`;
    const model = body?.model || 'clickdz-smart';
    const messages = normalizeMessages(body?.messages || []);
    const content = await this.runMakeAgent(messages, model);

    if (body?.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`
      );
      const chunks = content.match(/.{1,48}(\s|$)/g) || [content];
      for (const chunk of chunks) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`
        );
      }
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.json(openAIChatResponse(id, model, content));
  }

  /** extract text from an attached image via the Make OCR scenario */
  private async ocrImageContext(fileUrl: string): Promise<string> {
    if (!MAKE_OCR_WEBHOOK_URL || !fileUrl) return '';
    try {
      const response = await fetch(MAKE_OCR_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_url: fileUrl }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) return '';
      const data = (await response.json()) as { text?: string };
      return typeof data?.text === 'string' ? data.text.slice(0, 4000) : '';
    } catch {
      // OCR is best-effort context — never block generation on it
      return '';
    }
  }

  /** enhance a raw image prompt through the Make agent (best-effort) */
  private async enhanceImagePrompt(
    rawPrompt: string,
    ocrContext: string
  ): Promise<string> {
    try {
      const parts = [IMAGE_ENHANCER_GUIDELINES];
      if (ocrContext) {
        parts.push(
          `Content extracted from the user's attached reference image:\n"""${ocrContext}"""\nBlend this reference faithfully into the scene.`
        );
      }
      parts.push(`Request: ${rawPrompt}`);
      const enhanced = await this.runMakeAgent(
        [{ role: 'user', content: parts.join('\n\n') }],
        'clickdz-image-enhancer'
      );
      const cleaned = (enhanced || '').trim().replace(/^["'`]+|["'`]+$/g, '');
      // sanity: reject junk enhancements, keep the user's own words instead
      if (cleaned.length < 10 || cleaned.length > 4000) return rawPrompt;
      return cleaned;
    } catch {
      return rawPrompt;
    }
  }

  @Post(['/api/v1/images/generations', '/v1/images/generations'])
  async imageGenerations(@Body() body: any) {
    if (!OPENAI_IMAGE_API_KEY) {
      throw new HttpException(
        { error: { message: 'OpenAI image generation key is not configured', type: 'configuration_error', code: 'openai_image_key_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    const requestedModel = String(body?.model || '');
    const isClickDzImage = CLICKDZ_IMAGE_MODEL_IDS.has(requestedModel);

    let prompt = String(body?.prompt || '');
    let enhancedPrompt: string | undefined;
    let ocrUsed = false;
    if (isClickDzImage && prompt) {
      // ClickDz 1.0 pipeline: OCR reference (optional) -> Make enhancement
      const imageUrl =
        typeof body?.image_url === 'string' ? body.image_url : '';
      const ocrContext = imageUrl ? await this.ocrImageContext(imageUrl) : '';
      ocrUsed = !!ocrContext;
      enhancedPrompt = await this.enhanceImagePrompt(prompt, ocrContext);
      prompt = enhancedPrompt;
    }

    const model = isClickDzImage
      ? CLICKDZ_IMAGE_ENGINE
      : body?.model && body.model !== 'clickdz-image'
        ? body.model
        : 'dall-e-3';
    // gpt-image-1 rejects response_format/style and always returns b64_json;
    // dall-e-* accept response_format url. Build a valid payload for both.
    const isGptImage = String(model).startsWith('gpt-image');
    const payload: Record<string, unknown> = {
      model,
      prompt: prompt || body?.prompt || '',
      n: Math.min(Number(body?.n || 1), 1),
      size: body?.size || '1024x1024',
    };
    if (!isGptImage) {
      payload.response_format = body?.response_format || 'url';
      payload.style = body?.style || 'vivid';
    }
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_IMAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new HttpException(data, response.status);
    }
    // normalize: expose a data URL for b64 responses so url-consumers work
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item && !item.url && typeof item.b64_json === 'string') {
          item.url = `data:image/png;base64,${item.b64_json}`;
        }
      }
    }
    if (isClickDzImage) {
      data.clickdz = {
        model: 'clickdz-image-1.0',
        engine: CLICKDZ_IMAGE_ENGINE,
        enhanced_prompt: enhancedPrompt,
        reference_ocr_used: ocrUsed,
      };
    }
    return data;
  }

  /** deploy a single-file app to Vercel and wait briefly for it to go live */
  private async deployAppToVercel(slug: string, html: string) {
    const projectName = `clickdz-app-${slug}`.slice(0, 52);
    const teamQuery = VERCEL_TEAM_ID
      ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
      : '';
    const createRes = await fetch(
      `https://api.vercel.com/v13/deployments${teamQuery}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: projectName,
          files: [{ file: 'index.html', data: html }],
          projectSettings: { framework: null },
          target: 'production',
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    const created = (await createRes.json()) as any;
    if (!createRes.ok) {
      throw new HttpException(
        { error: { message: created?.error?.message || 'Vercel deployment failed', type: 'provider_error', code: 'vercel_deploy_failed' } },
        HttpStatus.BAD_GATEWAY
      );
    }
    // poll briefly until the deployment is READY (static deploys are fast)
    let state = created.readyState as string;
    for (let i = 0; i < 10 && state !== 'READY' && state !== 'ERROR'; i++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const pollRes = await fetch(
        `https://api.vercel.com/v13/deployments/${created.id}${teamQuery}`,
        {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        }
      );
      const polled = (await pollRes.json()) as any;
      state = polled.readyState || state;
    }
    return {
      slug,
      state,
      url: `https://${projectName}.vercel.app`,
      deploymentUrl: created.url ? `https://${created.url}` : undefined,
    };
  }

  @Post('/api/v1/apps/generate')
  async generateApp(@Body() body: any) {
    const startedAt = Date.now();
    this.logger.log(
      `[apps] generate request: prompt=${String(body?.prompt || '').slice(0, 80)}`
    );
    if (!VERCEL_TOKEN) {
      this.logger.warn('[apps] rejected: VERCEL_TOKEN missing');
      throw new HttpException(
        { error: { message: 'Vercel deployment is not configured', type: 'configuration_error', code: 'vercel_token_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new HttpException(
        { error: { message: 'A description of the app is required', type: 'invalid_request_error', code: 'prompt_missing' } },
        HttpStatus.BAD_REQUEST
      );
    }

    // 1. generate the app with the Make code agent (falls back to the
    //    default agent with inline guidelines when no dedicated agent is set)
    this.logger.log(
      `[apps] codegen start via agent=${MAKE_CODE_AGENT_ID ? 'code-agent' : 'default'}`
    );
    const reply = await this.runMakeAgent(
      [
        {
          role: 'user',
          content: `${APP_BUILDER_GUIDELINES}\n\nRequest: ${prompt}`,
        },
      ],
      'clickdz-apps',
      MAKE_CODE_AGENT_ID || undefined
    );
    this.logger.log(
      `[apps] codegen done in ${Math.round((Date.now() - startedAt) / 1000)}s, reply=${(reply || '').length} chars`
    );
    let html = extractHtmlApp(reply || '');
    if (!html) {
      throw new HttpException(
        { error: { message: 'The model did not return a valid app. Try a simpler description.', type: 'provider_error', code: 'app_generation_failed' } },
        HttpStatus.BAD_GATEWAY
      );
    }
    if (html.length > 400_000) {
      html = html.slice(0, 400_000);
    }
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${CLICKDZ_APP_WATERMARK}</body>`);
    }

    // 2. deploy — reusing the slug keeps the same live URL across iterations
    const slug =
      typeof body?.slug === 'string' && /^[a-z0-9-]{3,50}$/.test(body.slug)
        ? body.slug
        : slugifyAppName(prompt);
    this.logger.log(`[apps] deploying ${html.length} chars as slug=${slug}`);
    const deployed = await this.deployAppToVercel(slug, html);
    this.logger.log(
      `[apps] done in ${Math.round((Date.now() - startedAt) / 1000)}s: ${deployed.url} (${deployed.state})`
    );
    return {
      ...deployed,
      prompt,
      bytes: html.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  @Post('/api/voice/token')
  async deepgramToken() {
    if (!DEEPGRAM_API_KEY) {
      throw new HttpException({ error: 'Deepgram is not configured' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 60 }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new HttpException(data, response.status);
    }
    return data;
  }

  @Post(['/api/voice/tts', '/api/copilot/voice/tts'])
  async tts(@Body() body: any, @Res() res: Response) {
    if (!DEEPGRAM_API_KEY) {
      throw new HttpException({ ok: false, error: 'Deepgram is not configured' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const model = body?.voice || 'aura-2-thalia-en';
    const response = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text: body?.text || '' }),
    });
    if (!response.ok) {
      throw new HttpException({ ok: false, error: `Deepgram TTS failed: ${response.status}` }, HttpStatus.BAD_GATEWAY);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  }

  @Post(['/api/voice/transcribe', '/api/copilot/voice/transcribe'])
  async transcribe(@Req() req: Request) {
    if (!DEEPGRAM_API_KEY) {
      throw new HttpException({ ok: false, error: 'Deepgram is not configured' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      ok: false,
      error: 'Multipart transcription endpoint requires upload middleware; use Make.com STT webhook for browser audio uploads.',
    };
  }
}
