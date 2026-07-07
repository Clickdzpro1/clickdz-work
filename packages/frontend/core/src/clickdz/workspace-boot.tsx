// ClickDz Work — workspace-scoped boot: installs pending onboarding templates
// once, ensures every workspace has a starter template library, and mounts
// the floating voice guide. Rendered inside the workspace layout where
// DocsService is available.
import { DocsService } from '@affine/core/modules/doc';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';
import { useEffect } from 'react';

import { ensureTemplateLibrary, installPendingTemplates } from './installer';
import { VoiceGuide } from './voice-guide';

export const ClickDzWorkspaceBoot = () => {
  const docsService = useService(DocsService);
  const workspaceService = useService(WorkspaceService);
  const workspaceId = workspaceService.workspace.id;

  useEffect(() => {
    installPendingTemplates(docsService)
      .then(() => ensureTemplateLibrary(docsService, workspaceId))
      .catch(() => {
        /* best-effort — never block the workspace UI */
      });
  }, [docsService, workspaceId]);

  return <VoiceGuide />;
};
