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
import { createElement, type ReactNode } from 'react';

export type StudioId =
  | 'vdz'
  | 'apps'
  | 'shoperp'
  | 'voice'
  | 'integrations'
  | 'hermes'
  | 'openclaw';

export type StudioGroup = 'create' | 'commerce' | 'agents' | 'connect';

export interface StudioDef {
  id: StudioId;
  /** Display label, e.g. 'Vdz Studio' (emoji baked in where the sidebar uses it). */
  label: string;
  /** Route target for `workbench.open`; also the active-prefix via `startsWith`. */
  route: string;
  /** Thunk returning a boot-safe rc icon element, e.g. `() => createElement(FrameIcon)`. */
  icon: () => ReactNode;
  /** Grouping bucket for the switcher dropdown. */
  group: StudioGroup;
  /** Stable e2e selector, e.g. 'slider-bar-vdz-studio-button'. */
  testId: string;
  /** When true the sidebar renders a <BetaChip /> postfix. */
  beta?: boolean;
}

/**
 * The 7 studios, in sidebar display order (so `STUDIOS.map(...)` in
 * studios-section.tsx preserves the exact current visual order). The switcher
 * re-buckets these by `group`.
 *
 * Icons (boot-safe): vdz→FrameIcon, apps(/chat)→AiIcon, shoperp→BlockLinkIcon,
 * voice→VoiceIcon, integrations→BlockLinkIcon, hermes→ChatWithAiIcon,
 * openclaw→KeyboardIcon. beta: integrations/voice/shoperp/hermes/openclaw; vdz
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
    id: 'apps',
    label: 'ClickDz Apps',
    route: '/chat',
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
    id: 'shoperp',
    label: '🛍️ Shop ERP',
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
];

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
