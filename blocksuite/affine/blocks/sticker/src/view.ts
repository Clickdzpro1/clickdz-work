import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from '@blocksuite/affine-ext-loader';

import { StickerBlockSpec } from './sticker-spec.js';

export class StickerViewExtension extends ViewExtensionProvider {
  override name = 'affine-sticker-block';

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(StickerBlockSpec);
  }
}
