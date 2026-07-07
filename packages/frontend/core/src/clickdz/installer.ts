// ClickDz Work — one-shot template installer.
// Runs inside a loaded workspace (DocsService available). Reads the pending
// selection saved by the /welcome wizard and imports each chosen niche's 3
// markdown docs as real documents, then clears the flag. Uses the same
// createDoc + insertFromMarkdown pattern the app itself uses for AI content.
import { DebugLogger } from '@affine/debug';
import type { DocsService } from '@affine/core/modules/doc';

import { insertFromMarkdown } from '../blocksuite/utils/markdown-utils';
import { NICHES, PENDING_KEY, type PendingSelection } from './niches';

const logger = new DebugLogger('clickdz:installer');

// prefix for the one-shot "template library" install guard, keyed per workspace
const TEMPLATE_LIB_KEY_PREFIX = 'clickdz:tpl-lib:v1:';

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

// ClickDz Work — populates the sidebar "Template" menu so every workspace has
// a starter library, even if the /welcome wizard was never run. Installs one
// "hub" doc per niche (20 total) and marks each as a real template doc via
// docsService.createDoc({ isTemplate: true }) — the same option the built-in
// "Create new template" menu item uses (see template-doc/view/template-list-menu.tsx).
// One-shot per workspace, guarded by a localStorage flag set before the loop
// runs so a mid-install crash can never trigger a duplicate install.
export async function ensureTemplateLibrary(
  docsService: DocsService,
  workspaceId: string
) {
  const guardKey = TEMPLATE_LIB_KEY_PREFIX + workspaceId;
  try {
    if (localStorage.getItem(guardKey)) return;
  } catch {
    return;
  }

  // set the guard FIRST — before any doc is created — so a crash mid-loop
  // can't cause a double-install on next boot
  try {
    localStorage.setItem(guardKey, '1');
  } catch {
    /* ignore */
  }

  let existingTitles: Set<string>;
  try {
    existingTitles = new Set(
      docsService.list.docs$.value
        .filter(doc => !doc.trash$.value)
        .map(doc => doc.title$.value)
    );
  } catch (e) {
    logger.error('failed to read existing doc titles', e);
    existingTitles = new Set();
  }

  const contentModule = await import('./template-content').catch(e => {
    logger.error('failed to load template content', e);
    return null;
  });
  if (!contentModule) return;
  const { TEMPLATE_CONTENT } = contentModule;

  for (const niche of NICHES) {
    try {
      const pack = TEMPLATE_CONTENT[niche.id];
      if (!pack) continue;
      const tpl = pack.hub;
      if (existingTitles.has(tpl.title)) {
        logger.info(`skipped ${niche.id}/hub (already exists)`);
        continue;
      }
      const record = docsService.createDoc({
        title: tpl.title,
        isTemplate: true,
      });
      const { doc, release } = docsService.open(record.id);
      try {
        const store = doc.blockSuiteDoc;
        store.load();
        const [note] = store.getBlocksByFlavour('affine:note');
        // strip the H1 (already the doc title) and import the body markdown
        const body = tpl.content.replace(/^#\s.*(\r?\n)?/, '');
        await insertFromMarkdown(undefined, body, store, note?.id, 0);
        logger.info(`installed template ${niche.id}/hub`);
      } finally {
        release();
      }
    } catch (e) {
      logger.error(`failed to install template ${niche.id}/hub`, e);
    }
  }
}
