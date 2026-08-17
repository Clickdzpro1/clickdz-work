// SlidePro — thin client for the native backend AI routes. Everything goes
// through cdzApiUrl(...) so desktop/native builds resolve against the connected
// server (web is a no-op — same origin), mirroring the shoperp/social api.ts
// and the Vdz media hook. Each call returns a discriminated result so the UI
// can render loading / error / not-configured states without guessing.

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { nanoid } from 'nanoid';

import type { Slide, SlideLayout } from './types';

// ---------------------------------------------------------------------------
// Shared request options for the generator (steer the model, all optional).
// ---------------------------------------------------------------------------
export interface GenOptions {
  slideCount?: number;
  language?: string;
  audience?: string;
  tone?: string;
}

async function postJson<T>(
  path: string,
  body: unknown
): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(cdzApiUrl(path), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** Pull a human-friendly error message out of an AFFiNE error envelope. */
function errMessage(data: any, fallback: string): string {
  return (
    (typeof data?.message === 'string' && data.message) ||
    (typeof data?.error === 'string' && data.error) ||
    (typeof data?.error?.message === 'string' && data.error.message) ||
    fallback
  );
}

// ---------------------------------------------------------------------------
// Outline — prompt → editable section list.
// ---------------------------------------------------------------------------
export interface OutlineResult {
  ok: boolean;
  title?: string;
  outline?: string[];
  error?: string;
}

export async function generateOutline(
  prompt: string,
  opts: GenOptions = {}
): Promise<OutlineResult> {
  const r = await postJson<{ title?: string; outline?: string[] }>(
    '/api/v1/slidepro/outline',
    {
      prompt,
      slideCount: opts.slideCount,
      language: opts.language,
      audience: opts.audience,
    }
  );
  if (r.ok && Array.isArray(r.data?.outline) && r.data!.outline.length) {
    return { ok: true, title: r.data!.title, outline: r.data!.outline };
  }
  return {
    ok: false,
    error: errMessage(
      r.data,
      r.status === 0
        ? 'Réseau indisponible — réessayez.'
        : "La génération du plan a échoué. Réessayez."
    ),
  };
}

// ---------------------------------------------------------------------------
// Deck — prompt (+ optional edited outline) → full structured slides.
// ---------------------------------------------------------------------------
interface RawSlide {
  title?: string;
  layout?: string;
  bullets?: string[];
  bulletsRight?: string[];
  notes?: string;
  imagePrompt?: string;
}

export interface DeckResult {
  ok: boolean;
  title?: string;
  slides?: Slide[];
  error?: string;
}

/** Turn a backend RawSlide into a fully-populated local Slide (fresh ids). */
function hydrateSlide(raw: RawSlide): Slide {
  return {
    id: nanoid(10),
    title: typeof raw.title === 'string' ? raw.title : '',
    layout: (raw.layout as SlideLayout) ?? 'title-bullets',
    bullets: Array.isArray(raw.bullets)
      ? raw.bullets.filter(b => typeof b === 'string')
      : [],
    bulletsRight: Array.isArray(raw.bulletsRight)
      ? raw.bulletsRight.filter(b => typeof b === 'string')
      : [],
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    imagePrompt: typeof raw.imagePrompt === 'string' ? raw.imagePrompt : '',
    imageUrl: '',
  };
}

export async function generateDeck(
  prompt: string,
  outline: string[] | undefined,
  opts: GenOptions = {}
): Promise<DeckResult> {
  const r = await postJson<{ title?: string; slides?: RawSlide[] }>(
    '/api/v1/slidepro/deck',
    {
      prompt,
      outline: outline && outline.length ? outline : undefined,
      slideCount: opts.slideCount,
      language: opts.language,
      audience: opts.audience,
      tone: opts.tone,
    }
  );
  if (r.ok && Array.isArray(r.data?.slides) && r.data!.slides.length) {
    return {
      ok: true,
      title: r.data!.title,
      slides: r.data!.slides.map(hydrateSlide),
    };
  }
  return {
    ok: false,
    error: errMessage(
      r.data,
      r.status === 0
        ? 'Réseau indisponible — réessayez.'
        : 'La génération du deck a échoué. Réessayez.'
    ),
  };
}

// ---------------------------------------------------------------------------
// Image generation — reuses the app's EXISTING route (POST /api/v1/images/
// generations → {data:[{url}]}), exactly like the Vdz media hook + social
// composer. Degrades gracefully: any failure returns ok:false and the caller
// keeps the slide text-only.
// ---------------------------------------------------------------------------
export interface ImageResult {
  ok: boolean;
  url?: string;
  error?: string;
}

export async function generateSlideImage(
  prompt: string,
  model = 'cdzimage-2.0'
): Promise<ImageResult> {
  const trimmed = prompt.trim();
  if (!trimmed) return { ok: false, error: 'empty_prompt' };
  const r = await postJson<{
    data?: Array<{ url?: string }>;
    error?: unknown;
    message?: string;
  }>('/api/v1/images/generations', { prompt: trimmed, model });
  if (r.ok) {
    const url = r.data?.data?.[0]?.url;
    if (typeof url === 'string' && url) return { ok: true, url };
    return { ok: false, error: "Le modèle n'a pas renvoyé d'image." };
  }
  return {
    ok: false,
    error: errMessage(r.data, "Génération d'image indisponible."),
  };
}
