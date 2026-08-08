import {
  createCustomToolbarExtension,
  createToolbarMoreMenuConfig,
} from '@affine/core/blocksuite/view-extensions/editor-config/toolbar';
import { WorkspaceServerService } from '@affine/core/modules/cloud';
// WS6 — additive CDZ AI sticker element-toolbar actions (flag-gated).
import { createCdzStickerToolbarExtension } from '@affine/core/modules/stickers/toolbar';
// P5/E1 — discoverable "Stickers" senior tool + its panel web component.
import {
  cdzStickerSeniorTool,
  EdgelessCdzStickerButton,
} from '@affine/core/modules/stickers/senior-tool';
import { EditorSettingService } from '@affine/core/modules/editor-setting';
import { ToolbarMoreMenuConfigExtension } from '@blocksuite/affine/components/toolbar';
import { EditorSettingExtension } from '@blocksuite/affine/shared/services';
import type { ExtensionType } from '@blocksuite/store';
import type { FrameworkProvider } from '@toeverything/infra';

// Register the Sticker panel custom element once (idempotent guard).
if (!customElements.get('edgeless-cdz-sticker-button')) {
  customElements.define('edgeless-cdz-sticker-button', EdgelessCdzStickerButton);
}

declare global {
  interface HTMLElementTagNameMap {
    'edgeless-cdz-sticker-button': EdgelessCdzStickerButton;
  }
}

export function getEditorConfigExtension(
  framework: FrameworkProvider
): ExtensionType[] {
  const editorSettingService = framework.get(EditorSettingService);
  const workspaceServerService = framework.get(WorkspaceServerService);
  const baseUrl = workspaceServerService.server?.baseUrl ?? location.origin;

  return [
    EditorSettingExtension({
      // eslint-disable-next-line rxjs/finnish
      setting$: editorSettingService.editorSetting.settingSignal,
      set: (k, v) => editorSettingService.editorSetting.set(k, v),
    }),
    ToolbarMoreMenuConfigExtension(createToolbarMoreMenuConfig(framework)),

    createCustomToolbarExtension(editorSettingService.editorSetting, baseUrl),

    // Attaches "Animate" + "Generate sticker" to the sticker/image surface
    // elements, gated behind `enable_cdz_sticker_ai`.
    createCdzStickerToolbarExtension(),

    // P5/E1 — "Stickers" senior tool in the main edgeless toolbar.
    // Opens an inline panel with prompt input → generate → place.
    // Gated behind enable_cdz_sticker_ai; additive, no toolbar regressions.
    cdzStickerSeniorTool,
  ].flat();
}
