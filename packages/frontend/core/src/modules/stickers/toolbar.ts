// modules/stickers/toolbar.ts
//
// WS6 — additive edgeless element-toolbar actions for CDZ AI stickers.
//
// Provides two ToolbarModuleConfigs, wired via the core custom-toolbar
// extension (blocksuite/.../editor-config/toolbar/index.ts):
//
//   • Sticker element  → "Animate" (preset motion menu: bob/spin/pulse/bounce)
//   • Image element     → "Animate" (turn an edgeless image into an animated
//                          sticker using the same preset menu)
//
// Both are GATED behind the `enable_cdz_sticker_ai` BlockSuite flag so they
// cannot appear in stable builds — the flag defaults ON only in canary. The
// "Generate sticker" entry point (prompt → bridge image → static sticker) is a
// separate global action exported here too and appended to the image/sticker
// menus so it's reachable from the same surface without adding a net-new
// toolbar widget.
//
// All actions delegate to the pure module functions (generate.ts / animate.ts /
// provider.ts) — this file is only the declarative toolbar glue.

import { toast } from '@blocksuite/affine/components/toast';
import { EditorChevronDown } from '@blocksuite/affine/components/toolbar';
import { ImageBlockModel, StickerBlockModel } from '@blocksuite/affine/model';
import {
  ActionPlacement,
  type ToolbarAction,
  type ToolbarContext,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from '@blocksuite/affine/shared/services';
import { BlockFlavourIdentifier } from '@blocksuite/affine/std';
import type { ExtensionType } from '@blocksuite/affine/store';
import { ImageIcon, SmileIcon } from '@blocksuite/icons/lit';
import { html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import { animateBlockSourceToSticker } from './animate';
import { generateStickerImage } from './generate';
import {
  STICKER_ANIM_PRESET_LABELS,
  STICKER_ANIM_PRESETS,
  type StickerAnimPreset,
} from './lottie-presets';
import { addSticker, ingestStickerAsset } from './provider';

const FLAG = 'enable_cdz_sticker_ai';

function flagOn(ctx: ToolbarContext): boolean {
  try {
    return !!ctx.features.getFlag(FLAG);
  } catch {
    return false;
  }
}

/** Resolve the `sourceId` of whichever supported element is current. */
function currentSourceId(ctx: ToolbarContext): string | null {
  const sticker = ctx.getCurrentModelByType(StickerBlockModel);
  if (sticker) return sticker.props.sourceId ?? null;
  const image = ctx.getCurrentModelByType(ImageBlockModel);
  if (image) return image.props.sourceId ?? null;
  return null;
}

/**
 * Placement point for a newly generated/animated sticker. `addSticker` treats a
 * provided `point` as VIEW coords (it runs toModelCoord on it) and falls back
 * to the viewport center when omitted — center is exactly what we want here, so
 * we omit it and let the provider default apply.
 */
function pointFor(_ctx: ToolbarContext): [number, number] | undefined {
  return undefined;
}

// --- "Animate" — preset motion menu shared by sticker + image elements -------

function renderAnimateMenu(ctx: ToolbarContext) {
  const sourceId = currentSourceId(ctx);
  if (!sourceId) return null;

  const run = (preset: StickerAnimPreset) => {
    void (async () => {
      const id = await animateBlockSourceToSticker(ctx.std, sourceId, {
        preset,
        point: pointFor(ctx),
      });
      toast(
        ctx.host,
        id ? 'Animated sticker added' : "Couldn't animate this element"
      );
    })();
  };

  return html`
    <editor-menu-button
      .contentPadding=${'8px'}
      .button=${html`
        <editor-icon-button aria-label="Animate" .tooltip=${'Animate'}>
          ${ImageIcon()} ${EditorChevronDown}
        </editor-icon-button>
      `}
    >
      <div data-size="small" data-orientation="vertical">
        ${repeat(
          STICKER_ANIM_PRESETS,
          preset => preset,
          preset => html`
            <editor-menu-action
              data-testid=${`cdz-animate-${preset}`}
              @click=${() => run(preset)}
            >
              <span class="label">${STICKER_ANIM_PRESET_LABELS[preset]}</span>
            </editor-menu-action>
          `
        )}
      </div>
    </editor-menu-button>
  `;
}

const animateAction = {
  id: 'z.cdz-animate',
  placement: ActionPlacement.End,
  when: (ctx: ToolbarContext) => flagOn(ctx) && !!currentSourceId(ctx),
  content: (ctx: ToolbarContext) => renderAnimateMenu(ctx),
} as const satisfies ToolbarAction;

// --- "Generate sticker" — prompt → bridge image → static sticker -------------

async function runGenerateSticker(ctx: ToolbarContext) {
  // Minimal, dependency-free prompt capture. A richer inline panel can replace
  // this later; kept simple + flag-gated so it can't destabilize the toolbar.
  const subject =
    typeof window !== 'undefined'
      ? window.prompt('Describe the sticker to generate:')
      : null;
  if (!subject || !subject.trim()) return;

  toast(ctx.host, 'Generating sticker…');
  const { blob, fail } = await generateStickerImage({ prompt: subject });
  if (!blob) {
    const msg =
      fail === 'aiUnavailable'
        ? 'AI image service is unavailable'
        : fail === 'timeout'
          ? 'Sticker generation timed out. Please try again.'
          : fail === 'rateLimited'
            ? 'Daily image limit reached. Try again tomorrow.'
            : "Couldn't generate the sticker";
    toast(ctx.host, msg);
    return;
  }
  try {
    const sourceId = await ingestStickerAsset(ctx.std, blob);
    addSticker(ctx.std, sourceId, 'static', { point: pointFor(ctx) });
    toast(ctx.host, 'Sticker added');
  } catch {
    toast(ctx.host, "Couldn't place the sticker");
  }
}

const generateStickerAction = {
  id: 'z.cdz-generate-sticker',
  placement: ActionPlacement.End,
  label: 'Generate sticker',
  tooltip: 'Generate an AI sticker',
  icon: SmileIcon(),
  when: (ctx: ToolbarContext) => flagOn(ctx),
  run: (ctx: ToolbarContext) => void runGenerateSticker(ctx),
} as const satisfies ToolbarAction;

// --- Configs -----------------------------------------------------------------

const stickerToolbarConfig = {
  actions: [animateAction, generateStickerAction],
  when: ctx =>
    flagOn(ctx) && ctx.getSurfaceModelsByType(StickerBlockModel).length === 1,
} as const satisfies ToolbarModuleConfig;

const imageStickerToolbarConfig = {
  actions: [animateAction, generateStickerAction],
  when: ctx =>
    flagOn(ctx) && ctx.getSurfaceModelsByType(ImageBlockModel).length === 1,
} as const satisfies ToolbarModuleConfig;

/**
 * Toolbar extensions for the CDZ AI sticker actions. Registered from the core
 * custom-toolbar extension. Additive: only attaches to the sticker + image
 * surface elements, and only when the flag is on.
 */
export const createCdzStickerToolbarExtension = (): ExtensionType[] => [
  ToolbarModuleExtension({
    id: BlockFlavourIdentifier('custom:affine:surface:sticker'),
    config: stickerToolbarConfig,
  }),
  ToolbarModuleExtension({
    id: BlockFlavourIdentifier('custom:affine:surface:image'),
    config: imageStickerToolbarConfig,
  }),
];
