import { AppAccessGate } from '@affine/core/modules/studio/app-access-gate';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';

import { C } from '../shoperp/shoperp-shared';
import { SlideProStudio } from './SlideProStudio';

// ---------------------------------------------------------------------------
// SlidePro — top-level sidebar entry (StudioId 'slidepro', route '/slidepro';
// see modules/studio/registry.ts). This is the NATIVE in-house studio that
// replaced the old iframed presenton fork: a full React presentation generator
// + editor that reuses the app's OWN copilot AI gateway (POST /api/v1/slidepro/
// outline + /deck) and image-generation route (POST /api/v1/images/generations).
//
// Decks are persisted per-workspace in localStorage, keyed by the current
// workspace id (the closest stable scope at this top level, matching how the
// former panel keyed its state). Header scaffold mirrors the other studio pages
// (ViewTitle/ViewIcon/ViewHeader/ViewBody + inline styles, no i18n — the studio
// itself is fully French).
// ---------------------------------------------------------------------------

const SlideProPage = () => {
  const workspaceService = useService(WorkspaceService);
  const workspaceId = workspaceService.workspace.id;

  return (
    <>
      <ViewTitle title="SlidePro" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            color: C.text,
          }}
        >
          <span style={{ fontSize: 16 }}>📽️</span>
          SlidePro
        </div>
      </ViewHeader>
      <ViewBody>
        <AppAccessGate app="SLIDE_PRO">
          <div style={{ height: '100%', width: '100%' }}>
            <SlideProStudio workspaceId={workspaceId} />
          </div>
        </AppAccessGate>
      </ViewBody>
    </>
  );
};

export const Component = () => {
  return <SlideProPage />;
};
