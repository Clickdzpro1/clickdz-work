// ClickDz Work — workspace-scoped boot: installs pending onboarding templates
// once, and mounts the floating voice guide. Rendered inside the workspace
// layout where DocsService is available.
import { DocsService } from '@affine/core/modules/doc';
import { useService } from '@toeverything/infra';
import { useEffect } from 'react';

import { installPendingTemplates } from './installer';
import { VoiceGuide } from './voice-guide';

export const ClickDzWorkspaceBoot = () => {
  const docsService = useService(DocsService);

  useEffect(() => {
    installPendingTemplates(docsService).catch(() => {
      /* best-effort — never block the workspace UI */
    });
  }, [docsService]);

  return <VoiceGuide />;
};
