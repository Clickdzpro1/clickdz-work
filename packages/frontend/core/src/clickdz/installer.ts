// ClickDz Work — one-shot template installer.
// Runs inside a loaded workspace (DocsService available). Reads the pending
// selection saved by the /welcome wizard and imports each chosen niche's 3
// markdown docs as real documents, then clears the flag. Uses the same
// createDoc + insertFromMarkdown pattern the app itself uses for AI content.
import { DebugLogger } from '@affine/debug';
import type { DocsService } from '@affine/core/modules/doc';

import { insertFromMarkdown } from '../blocksuite/utils/markdown-utils';
import { PENDING_KEY, type PendingSelection } from './niches';

const logger = new DebugLogger('clickdz:installer');

export async function installPendingTemplates(docsService: DocsService) {
  let pending: PendingSelection | null = null;
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    pending = JSON.parse(raw) as PendingSelection;
  } catch {
    return;
  }
  if (!pending || !Array.isArray(pending.niches) || !pending.niches.length) {
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    return;
  }

  // clear FIRST so a crash can never cause a double-install on next boot
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }

  const { TEMPLATE_CONTENT } = await import('./template-content');

  for (const nicheId of pending.niches) {
    const pack = TEMPLATE_CONTENT[nicheId];
    if (!pack) continue;
    for (const kind of ['hub', 'workflow', 'tracker'] as const) {
      const tpl = pack[kind];
      try {
        const record = docsService.createDoc({ title: tpl.title });
        const { doc, release } = docsService.open(record.id);
        try {
          const store = doc.blockSuiteDoc;
          store.load();
          const [note] = store.getBlocksByFlavour('affine:note');
          // strip the H1 (already the doc title) and import the body markdown
          const body = tpl.content.replace(/^#\s.*(\r?\n)?/, '');
          await insertFromMarkdown(undefined, body, store, note?.id, 0);
          logger.info(`installed ${nicheId}/${kind}`);
        } finally {
          release();
        }
      } catch (e) {
        logger.error(`failed to install ${nicheId}/${kind}`, e);
      }
    }
  }
}
