/**
 * Studio registry — the single source of truth for the ClickDz creative
 * surfaces. The sidebar section, the studio switcher, the command palette,
 * notifications and the context broker all read this array so route/label/icon
 * metadata lives in exactly one place.
 *
 * This is a PURE module: a typed const array + a lookup function, with NO
 * framework wiring. (RecentStudiosService — the reactive part — is wired
 * separately in ./index.ts.)
 *
 * ⚠️ Boot-safe icons only. Importing a non-existent `@blocksuite/icons/rc`
 * export resolves to `undefined` and crashes React render at boot, so this file
 * imports ONLY the six symbols already proven present in prod:
 * FrameIcon, AiIcon, BlockLinkIcon, VoiceIcon, ChatWithAiIcon, KeyboardIcon.
 */
import {
  AiIcon,
  BlockLinkIcon,
  ChatWithAiIcon,
  FrameIcon,
  KeyboardIcon,
  VoiceIcon,
} from '@blocksuite/icons/rc';
import { createElement, type ReactElement, type SVGAttributes } from 'react';

export type StudioId =
  | 'vdz'
  | 'apps'
  | 'shoperp'
  | 'voice'
  | 'integrations'
  | 'hermes'
  | 'openclaw'
  | 'agents'
  | 'vpic';

export type StudioGroup = 'create' | 'commerce' | 'agents' | 'connect';

/**
 * Capability-flag keys a studio entry may be gated behind. `undefined` (the
 * common case) = always visible. Two flags today, each mapped to a backend caps
 * bit that rides the SAME `GET /api/v1/agents` caps object (see
 * {@link visibleStudios}):
 *   · 'agents-multi' → `caps.multi` (env CDZ_AGENTS_MULTI) gates the unified
 *     `/agents` studio.
 *   · 'vpic'         → `caps.vpicEnabled` (env CDZ_VPIC_ENABLED) gates the VPIC
 *     image-editor studio.
 * A string-literal union (not `string`) so a typo can't silently mint a
 * never-visible entry.
 */
export type StudioFlag = 'agents-multi' | 'vpic';

export interface StudioDef {
  id: StudioId;
  /** Display label, e.g. 'Vdz Studio' (emoji baked in where the sidebar uses it). */
  label: string;
  /** Route target for `workbench.open`; also the active-prefix via `startsWith`. */
  route: string;
  /**
   * Thunk returning a boot-safe rc icon element, e.g. `() => createElement(FrameIcon)`.
   * Typed as an SVG element (not ReactNode) because sidebar consumers
   * (`MenuItem`/`MenuLinkItem` `icon` prop) `cloneElement` it and require
   * `ReactElement<SVGAttributes<SVGElement>>` — a non-element ReactNode would
   * crash cloneElement at runtime, so the loose type was hiding a real hazard.
   */
  icon: () => ReactElement<SVGAttributes<SVGElement>>;
  /** Grouping bucket for the switcher dropdown. */
  group: StudioGroup;
  /** Stable e2e selector, e.g. 'slider-bar-vdz-studio-button'. */
  testId: string;
  /** When true the sidebar renders a <BetaChip /> postfix. */
  beta?: boolean;
  /**
   * Optional capability gate. When set, the entry is visible only if the
   * matching `caps` flag is on (see {@link visibleStudios}); absent ⇒ always
   * visible. Entries WITHOUT a flag are unconditional (byte-identical legacy
   * behavior). The unified /agents entry carries 'agents-multi'; the VPIC entry
   * carries 'vpic'.
   */
  flag?: StudioFlag;
}

/**
 * The studios, in sidebar display order (so `STUDIOS.map(...)` in
 * studios-section.tsx preserves the exact current visual order). The switcher
 * re-buckets these by `group`.
 *
 * The first 7 entries are unconditional (the legacy roster, unchanged). The
 * 8th — the unified `agents` entry — carries `flag:'agents-multi'`; the 9th —
 * the VPIC image-editor entry — carries `flag:'vpic'`. Both flag-gated entries
 * are appended LAST so that when their flag is off they are filtered out by
 * {@link visibleStudios} and the rendered set is byte-identical to today. The
 * agents entry sits after openclaw (its group siblings) so it reads naturally at
 * the bottom of the agents cluster when on; the vpic entry is appended after it
 * (a distinct 'create'-group surface, kept last so a flags-off sidebar is
 * untouched).
 *
 * Icons (boot-safe): vdz→FrameIcon, apps(/apps)→AiIcon, shoperp→BlockLinkIcon,
 * voice→VoiceIcon, integrations→BlockLinkIcon, hermes→ChatWithAiIcon,
 * openclaw→KeyboardIcon, agents→ChatWithAiIcon (reused), vpic→FrameIcon
 * (reused). beta: integrations/voice/shoperp/hermes/openclaw/agents/vpic; vdz
 * and apps are not beta.
 */
export const STUDIOS: StudioDef[] = [
  {
    id: 'vdz',
    label: 'Vdz Studio',
    route: '/vdz',
    icon: () => createElement(FrameIcon),
    group: 'create',
    testId: 'slider-bar-vdz-studio-button',
  },
  {
    // Routes to the App Builder's own page, NOT to '/chat'. Pointing this at
    // '/chat' made it the exact same destination as the sidebar's plain AI
    // entry, so "ClickDz Apps" opened an empty conversation and the builder
    // itself was unreachable until after a generation. Keeps AiIcon (boot-safe,
    // already imported) — the surface is still AI-driven, just its own page.
    id: 'apps',
    label: 'ClickDz Apps',
    route: '/apps',
    icon: () => createElement(AiIcon),
    group: 'commerce',
    testId: 'slider-bar-clickdz-apps-button',
  },
  {
    id: 'integrations',
    label: '🔌 Integrations',
    route: '/integrations',
    icon: () => createElement(BlockLinkIcon),
    group: 'connect',
    testId: 'slider-bar-integrations-button',
    beta: true,
  },
  {
    // Named DzOS, matching the boutique→ERP rename that went through the
    // dashboard and wizard: one store is no longer the whole of this surface,
    // so "Ma boutique" undersold it. The 🛍️ glyph is kept deliberately — it is
    // the visual anchor a merchant arriving from Facebook selling actually
    // scans for, which is what the plain-French label used to provide.
    id: 'shoperp',
    label: '🛍️ DzOS',
    route: '/shoperp',
    icon: () => createElement(BlockLinkIcon),
    group: 'commerce',
    testId: 'slider-bar-shoperp-button',
    beta: true,
  },
  {
    id: 'voice',
    label: 'Voice Studio',
    route: '/voice',
    icon: () => createElement(VoiceIcon),
    group: 'create',
    testId: 'slider-bar-voice-studio-button',
    beta: true,
  },
  {
    id: 'hermes',
    label: 'Hermes',
    route: '/hermes',
    icon: () => createElement(ChatWithAiIcon),
    group: 'agents',
    testId: 'slider-bar-hermes-button',
    beta: true,
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    route: '/openclaw',
    icon: () => createElement(KeyboardIcon),
    group: 'agents',
    testId: 'slider-bar-openclaw-button',
    beta: true,
  },
  {
    // Unified /agents studio (R7). flag-gated on caps.multi (CDZ_AGENTS_MULTI):
    // hidden by visibleStudios() until the flag is on, so flags-off is a no-op.
    // Reuses ChatWithAiIcon (already boot-safe imported) — no new icon import.
    id: 'agents',
    label: 'Agents',
    route: '/agents',
    icon: () => createElement(ChatWithAiIcon),
    group: 'agents',
    testId: 'slider-bar-agents-button',
    beta: true,
    flag: 'agents-multi',
  },
  {
    // VPIC image-editor studio (R14). flag-gated on caps.vpicEnabled
    // (CDZ_VPIC_ENABLED): hidden by visibleStudios() until the flag is on, so
    // flags-off is a no-op (byte-identical sidebar). Reuses FrameIcon (already
    // boot-safe imported, same glyph as vdz — both 'create'-group canvas
    // surfaces) — no new icon import (a missing rc icon crashes at boot).
    id: 'vpic',
    label: 'Studio Image',
    route: '/vpic',
    icon: () => createElement(FrameIcon),
    group: 'create',
    testId: 'slider-bar-vpic-studio-button',
    beta: true,
    flag: 'vpic',
  },
];

/**
 * The subset of {@link STUDIOS} that should be VISIBLE in nav surfaces (sidebar
 * section + switcher) given the caller's capabilities. Flag-less entries are
 * always kept; a flag-gated entry is kept only when its flag is on in `caps`.
 *
 * Two gates today, each reading a bit off the SAME caps object the sidebar
 * already passes (from `useAgents()` — the `GET /api/v1/agents` caps payload):
 *   · `flag:'agents-multi'` ⇒ requires `caps.multi`.
 *   · `flag:'vpic'`         ⇒ requires `caps.vpicEnabled`.
 * When `caps` is undefined (the common pre-load / feature-dark / 404 case) or a
 * gated bit is false/absent, the matching entry is dropped and the result is
 * REFERENTIALLY the legacy roster minus that entry — i.e. byte-identical to what
 * the sidebar rendered before the feature. The order of surviving entries is
 * preserved (a plain filter). `caps.vpicEnabled` is optional in the param type
 * because the FE `AgentCaps` doesn't declare it (the backend adds it to the caps
 * wire object — R14), so an absent bit reads `undefined` ⇒ falsy ⇒ hidden.
 *
 * Pure and side-effect-free: safe to call every render. Routing is NOT affected
 * by this — the /agents + /vpic routes stay registered unconditionally in
 * workbench-router.ts, and {@link studioForPath} still resolves them — only nav
 * VISIBILITY is gated here. That keeps a bookmarked/deep-linked /agents or /vpic
 * URL working even before the sidebar entry appears.
 *
 * DECISION (documented per contract): the legacy standalone hermes + openclaw
 * entries are KEPT ALWAYS (the safer default). Turning on `caps.multi` ADDS the
 * unified /agents entry; it does NOT hide hermes/openclaw. Their routes/testIds
 * live forever as aliases, so no existing bookmark, e2e selector, or muscle
 * memory breaks. (A future round may collapse them behind a preference — until
 * then, additive-only.)
 */
export function visibleStudios(caps?: {
  multi?: boolean;
  vpicEnabled?: boolean;
}): StudioDef[] {
  return STUDIOS.filter(studio => {
    if (studio.flag === 'agents-multi') {
      return !!caps?.multi;
    }
    if (studio.flag === 'vpic') {
      return !!caps?.vpicEnabled;
    }
    return true;
  });
}

/**
 * Resolve the studio owning a pathname by longest matching route prefix.
 * Longest-prefix wins so nested routes (e.g. `/vdz/123`) still resolve to `vdz`
 * and a shorter prefix can never shadow a more specific one.
 */
export function studioForPath(pathname: string): StudioDef | undefined {
  let best: StudioDef | undefined;
  for (const studio of STUDIOS) {
    if (
      pathname === studio.route ||
      pathname.startsWith(studio.route + '/')
    ) {
      if (!best || studio.route.length > best.route.length) {
        best = studio;
      }
    }
  }
  return best;
}
