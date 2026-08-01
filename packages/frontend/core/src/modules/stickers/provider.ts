import type { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

/**
 * Ingest a File or Blob into the workspace blob store and return its sourceId.
 */
export async function ingestStickerAsset(
  std: BlockStdScope,
  file: File | Blob
): Promise<string> {
  const sourceId = await std.workspace.blobSync.set(file);
  return sourceId;
}

/**
 * Ingest a single emoji character as a centered 96×96 SVG blob.
 */
export async function ingestEmojiAsSticker(
  std: BlockStdScope,
  emoji: string
): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <text x="48" y="68" text-anchor="middle" font-size="72">${emoji}</text>
  </svg>`;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  return ingestStickerAsset(std, blob);
}

/** Place a sticker block on the edgeless canvas; returns the block id. */
export function addSticker(
  std: BlockStdScope,
  sourceId: string,
  stickerType: 'emoji' | 'static' | 'animated',
  options: {
    point?: [number, number];
    width?: number;
    height?: number;
    animSrc?: string;
    animAutoplay?: boolean;
  } = {}
): string {
  const gfx = std.get(GfxControllerIdentifier);
  const [x, y] = options.point
    ? gfx.viewport.toModelCoord(...options.point)
    : gfx.viewport.center;
  const w = options.width ?? 96;
  const h = options.height ?? 96;

  // Lay out at the center of the drop/pick point.
  const xywh = `[${Math.round(x - w / 2)},${Math.round(y - h / 2)},${w},${h}]`;

  const [blockId] = std.store.addBlocks(
    [
      {
        flavour: 'affine:sticker',
        blockProps: {
          sourceId,
          stickerType,
          animSrc: options.animSrc,
          animAutoplay: options.animAutoplay ?? false,
          width: w,
          height: h,
          xywh,
          rotate: 0,
          index: gfx.layer.generateIndex(),
        },
      },
    ],
    gfx.surface
  );

  gfx.selection.set({ elements: [blockId], editing: false });
  return blockId;
}
