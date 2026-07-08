import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
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

  private async runMakeAgent(messages: Array<{ role: string; content: string }>, model: string) {
    this.assertMakeReady();
    const joined = messages
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');
    const agentId = hasArabic(joined) || model.includes('arabic') ? MAKE_ARABIC_AGENT_ID : MAKE_AGENT_ID;
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

  @Post(['/api/v1/images/generations', '/v1/images/generations'])
  async imageGenerations(@Body() body: any) {
    if (!OPENAI_IMAGE_API_KEY) {
      throw new HttpException(
        { error: { message: 'OpenAI image generation key is not configured', type: 'configuration_error', code: 'openai_image_key_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    const model =
      body?.model && body.model !== 'clickdz-image' ? body.model : 'dall-e-3';
    // gpt-image-1 rejects response_format/style and always returns b64_json;
    // dall-e-* accept response_format url. Build a valid payload for both.
    const isGptImage = String(model).startsWith('gpt-image');
    const payload: Record<string, unknown> = {
      model,
      prompt: body?.prompt || '',
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
    return data;
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
