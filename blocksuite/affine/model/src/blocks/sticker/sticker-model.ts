import type {
  GfxCommonBlockProps,
  GfxElementGeometry,
} from '@blocksuite/std/gfx';
import { GfxCompatible } from '@blocksuite/std/gfx';
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from '@blocksuite/store';

import type { BlockMeta } from '../../utils/types.js';

export type StickerBlockProps = {
  sourceId?: string;
  width?: number;
  height?: number;
  rotate: number;
  stickerType: 'emoji' | 'static' | 'animated';
  /** Optional Lottie blob ref for .json/.lottie files. When set + autoplay,
   *  the renderer mounts a dotlottie canvas instead of an <img>. */
  animSrc?: string;
  animAutoplay: boolean;
} & Omit<GfxCommonBlockProps, 'scale'> &
  BlockMeta;

const defaultStickerProps: StickerBlockProps = {
  sourceId: '',
  width: 96,
  height: 96,
  index: 'a0',
  xywh: '[0,0,0,0]',
  lockedBySelf: false,
  rotate: 0,
  stickerType: 'static',
  animSrc: undefined,
  animAutoplay: false,
  'meta:createdAt': undefined,
  'meta:createdBy': undefined,
  'meta:updatedAt': undefined,
  'meta:updatedBy': undefined,
};

export const StickerBlockSchema = defineBlockSchema({
  flavour: 'affine:sticker',
  props: () => defaultStickerProps,
  metadata: {
    version: 1,
    role: 'content',
  },
  toModel: () => new StickerBlockModel(),
});

export const StickerBlockSchemaExtension = BlockSchemaExtension(StickerBlockSchema);

export class StickerBlockModel
  extends GfxCompatible<StickerBlockProps>(BlockModel)
  implements GfxElementGeometry {}
