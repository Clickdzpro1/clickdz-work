// ClickDz Work — Template Installer v2.
// Upgrades niche tracker docs from markdown tables to real affine:database blocks
// with kanban + table views. Hub and workflow docs remain markdown.
// Guard keys bumped to v2 to enable upgrades without v1 duplication.
import { DebugLogger } from '@affine/debug';
import type { DocsService } from '@affine/core/modules/doc';
import { Text } from '@blocksuite/affine/store';

import { insertFromMarkdown } from '../blocksuite/utils/markdown-utils';
import { NICHES, PENDING_KEY, type PendingSelection } from './niches';
import { TRACKER_SCHEMAS, buildDatabaseBlock } from './template-systems';

const logger = new DebugLogger('clickdz:installer:v2');

// v2 guard keys — prevents re-install and allows upgrading from v1
const TEMPLATE_LIB_KEY_PREFIX = 'clickdz:tpl-lib:v2:';
const PENDING_KEY_V2 = 'clickdz:pending-templates:v2';

// ─── install pending docs from wizard ───────────────────────────
export async function installPendingTemplatesV2(docsService: DocsService) {
  let pending: PendingSelection | null = null;
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    pending = JSON.parse(raw) as PendingSelection;
  } catch {
    return;
  }
  if (!pending || !Array.isArray(pending.niches) || !pending.niches.length) {
    try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
    return;
  }

  // clear FIRST so crash never causes double-install
  try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }

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
          // strip H1 (already the doc title) and import body markdown
          const body = tpl.content.replace(/^#\s.*(\r?\n)?/, '');
          await insertFromMarkdown(undefined, body, store, note?.id, 0);

          // v2: for tracker docs, add real database block if schema exists
          if (kind === 'tracker' && note?.id) {
            const schema = TRACKER_SCHEMAS[nicheId];
            if (schema) {
              try {
                buildDatabaseBlock(store, note.id, schema);
                logger.info(`installed db ${nicheId}/tracker`);
              } catch (dbErr) {
                logger.error(`failed db ${nicheId}/tracker`, dbErr);
              }
            }
          }
          logger.info(`installed v2 ${nicheId}/${kind}`);
        } finally {
          release();
        }
      } catch (e) {
        logger.error(`failed to install v2 ${nicheId}/${kind}`, e);
      }
    }
  }

  // write v2 pending flag so v1 installer skips
  try { localStorage.setItem(PENDING_KEY_V2, '1'); } catch { /* ignore */ }
}

// ─── sidebar template library (isTemplate docs) ───────────────────
export async function ensureTemplateLibraryV2(
  docsService: DocsService,
  workspaceId: string
) {
  const guardKey = TEMPLATE_LIB_KEY_PREFIX + workspaceId;
  try { if (localStorage.getItem(guardKey)) return; } catch { return; }

  // set guard FIRST before any doc creation
  try { localStorage.setItem(guardKey, '1'); } catch { /* ignore */ }

  // skip if v1 was installed — v2 replaces it
  try { localStorage.removeItem('clickdz:tpl-lib:v1:' + workspaceId); } catch { /* ignore */ }

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
        const body = tpl.content.replace(/^#\s.*(\r?\n)?/, '');
        await insertFromMarkdown(undefined, body, store, note?.id, 0);
        logger.info(`installed template v2 ${niche.id}/hub`);
      } finally {
        release();
      }
    } catch (e) {
      logger.error(`failed to install template v2 ${niche.id}/hub`, e);
    }
  }
}

// ─── backward-compatible entry (called by boot/init) ─────────────
export async function installPendingTemplates(docsService: DocsService) {
  // v2 takes precedence — if v2 pending key exists, skip
  try {
    if (localStorage.getItem(PENDING_KEY_V2)) {
      // already processed by v2
      return;
    }
  } catch { /* ignore */ }

  await installPendingTemplatesV2(docsService);
}

export async function ensureTemplateLibrary(
  docsService: DocsService,
  workspaceId: string
) {
  await ensureTemplateLibraryV2(docsService, workspaceId);
}
