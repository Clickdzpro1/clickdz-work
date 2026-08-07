import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from '@blocksuite/affine-ext-loader';
import { StickerBlockSchemaExtension } from '@blocksuite/affine-model';

/**
 * Registers the `affine:sticker` block SCHEMA into the store.
 *
 * The sticker block already had a VIEW extension (StickerViewExtension, wired
 * in blocksuite/affine/all/src/extensions/view.ts) but no STORE extension, so
 * its schema was never registered — meaning `store.addBlocks({ flavour:
 * 'affine:sticker' })` would have thrown "schema not found". This mirrors the
 * ImageStoreExtension pattern and makes the pre-existing sticker infra
 * (model + renderer + provider helpers) actually usable. Additive: no other
 * block's schema is touched.
 */
export class StickerStoreExtension extends StoreExtensionProvider {
  override name = 'affine-sticker-block';

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([StickerBlockSchemaExtension]);
  }
}
