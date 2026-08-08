// ClickDz Work — workspace-scoped boot: installs pending onboarding templates
// once and ensures every workspace has a starter template library. Rendered
// inside the workspace layout where DocsService is available.
//
// No floating voice "call agent" mounts here by design. Voice generation and
// transcription live, deliberately, in Voice Studio (/voice).
import { DocsService } from '@affine/core/modules/doc';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useLiveData, useService } from '@toeverything/infra';
import { useEffect } from 'react';

import { cdzApiUrl } from '../blocksuite/ai/provider';
import { insertFromMarkdown } from '../blocksuite/utils/markdown-utils';
import { ensureTemplateLibrary, installPendingTemplates } from './installer';
import { ONBOARDING_CSS_FIX, PENDING_PERSONALIZE_KEY } from './niches';

// The seeded AFFiNE onboarding docs are imported from
// `@affine/templates/onboarding.zip` in `utils/first-app-data.ts`. On import,
// `ZipTransformer.importDocs` runs `replaceIdMiddleware`, which regenerates
// every page's doc id — so the doc ids in the snapshot are NOT stable in the
// workspace and cannot be matched. The only stable signal is the title (the
// `titleMiddleware` preserves it), which is exactly what `first-app-data.ts`
// itself keys off ("Getting Started" / "How to use folder and Tags").
//
// The previous matcher required the word "affine" in the title, but neither
// seeded doc contains it — so it was a silent no-op and never trashed anything.
//
// Match against the exact set of known seeded onboarding titles (normalized —
// the "Getting Started" snapshot title has a trailing space). Restricting to a
// known allow-set guards against ever trashing arbitrary user content.
const LEGACY_ONBOARDING_TITLES = new Set([
  'getting started',
  'how to use folder and tags',
]);

function isSeededOnboardingDoc(title: string) {
  return LEGACY_ONBOARDING_TITLES.has(title.trim().toLowerCase());
}

export const ClickDzWorkspaceBoot = () => {
  const docsService = useService(DocsService);
  const workspaceService = useService(WorkspaceService);
  const workspaceId = workspaceService.workspace.id;
  const docs = useLiveData(docsService.list.docs$);

  useEffect(() => {
    for (const record of docs ?? []) {
      if (
        !record.trash$.value &&
        isSeededOnboardingDoc(record.title$.value || '')
      ) {
        record.moveToTrash();
      }
    }
  }, [docs]);

  useEffect(() => {
    // Inject CSS fix for white text on white backgrounds in onboarding/welcome pages
    const styleId = 'clickdz-onboarding-css-fix';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = ONBOARDING_CSS_FIX;
      document.head.appendChild(style);
    }
    installPendingTemplates(docsService)
      .then(() => ensureTemplateLibrary(docsService, workspaceId))
      .then(async () => {
        // E2: consume PENDING_PERSONALIZE_KEY (one-shot, crash-safe).
        // Clear first so a crash never causes double-install (mirrors PENDING_KEY pattern).
        let pendingJson: string | null = null;
        try {
          pendingJson = localStorage.getItem(PENDING_PERSONALIZE_KEY);
          if (pendingJson) {
            localStorage.removeItem(PENDING_PERSONALIZE_KEY);
          }
        } catch {
          /* storage unavailable — skip */
        }
        if (!pendingJson) return;

        // POST profile to personalize/templates (target docs + whiteboard)
        let result: {
          docs?: Array<{ kind: string; title: string; markdown: string }>;
          whiteboard?: Array<{ title: string; seedNotes?: string[] }>;
        } | null = null;
        try {
          const profile = JSON.parse(pendingJson);
          const res = await fetch(
            cdzApiUrl('/api/v1/cdz/personalize/templates'),
            {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profile, target: 'docs' }),
            }
          );
          if (res.ok) {
            result = await res.json();
          }
        } catch {
          /* best-effort: model down or network error — skip gracefully */
        }
        if (!result) return;

        // Install returned docs[] via the same path as installer-v2
        if (Array.isArray(result.docs)) {
          for (const docItem of result.docs) {
            if (!docItem || typeof docItem.title !== 'string' || !docItem.title.trim()) continue;
            try {
              const record = docsService.createDoc({ title: docItem.title.trim() });
              const { doc, release } = docsService.open(record.id);
              try {
                const store = doc.blockSuiteDoc;
                store.load();
                const [note] = store.getBlocksByFlavour('affine:note');
                const body = (docItem.markdown ?? '').replace(/^#\s.*(\r?\n)?/, '');
                if (body.trim()) {
                  await insertFromMarkdown(undefined, body, store, note?.id, 0);
                }
              } finally {
                release();
              }
            } catch {
              /* skip failed doc — never block the UI */
            }
          }
        }

        // Seed whiteboard docs (edgeless) with seed notes as plain text
        if (Array.isArray(result.whiteboard)) {
          for (const wb of result.whiteboard) {
            if (!wb || typeof wb.title !== 'string' || !wb.title.trim()) continue;
            try {
              const record = docsService.createDoc({ title: wb.title.trim() });
              const { doc, release } = docsService.open(record.id);
              try {
                const store = doc.blockSuiteDoc;
                store.load();
                const [note] = store.getBlocksByFlavour('affine:note');
                const notes = Array.isArray(wb.seedNotes) ? wb.seedNotes.join('\n\n') : '';
                if (notes.trim() && note?.id) {
                  await insertFromMarkdown(undefined, notes, store, note.id, 0);
                }
              } finally {
                release();
              }
            } catch {
              /* skip — best-effort */
            }
          }
        }
      })
      .catch(() => {
        /* best-effort — never block the workspace UI */
      });
  }, [docsService, workspaceId]);

  // Effects only — this component renders nothing.
  return null;
};
