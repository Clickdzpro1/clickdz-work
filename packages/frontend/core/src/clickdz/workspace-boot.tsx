// ClickDz Work — workspace-scoped boot: installs pending onboarding templates
// once and ensures every workspace has a starter template library. Rendered
// inside the workspace layout where DocsService is available.
//
// The floating voice-guide orb ("call agent") that used to mount here was
// removed: it captured the Space bar app-wide, streamed the microphone to
// Deepgram on every workspace, and coached users on AFFiNE doc/edgeless
// concepts that are irrelevant to a ClickDz merchant. Voice generation and
// transcription remain available, deliberately, in Voice Studio (/voice).
import { DocsService } from '@affine/core/modules/doc';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useLiveData, useService } from '@toeverything/infra';
import { useEffect } from 'react';

import { ensureTemplateLibrary, installPendingTemplates } from './installer';
import { ONBOARDING_CSS_FIX } from './niches';

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
      .catch(() => {
        /* best-effort — never block the workspace UI */
      });
  }, [docsService, workspaceId]);

  // Effects only — this component renders nothing.
  return null;
};
