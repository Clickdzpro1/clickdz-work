import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';
import { useCallback } from 'react';

import { C } from '../shoperp/shoperp-shared';
import { ZoomPlusPanel } from '../shoperp/zoomplus';

// ---------------------------------------------------------------------------
// ZOOM+ — top-level sidebar entry (promoted out of the ERP dashboard's tab
// strip; see modules/studio/registry.ts). The tab still exists inside
// shoperp/dashboard.tsx too — both surfaces render the SAME panel component.
// Header scaffold mirrors the other promoted-panel-style pages (Voice Studio,
// DzOS): ViewTitle/ViewIcon/ViewHeader/ViewBody + inline styles, no i18n.
//
// ZoomPlusPanel's `slug` prop was designed for a shop-scoped context (it's
// used only as a localStorage key suffix and to build a per-shop health-check
// URL). At this top level there is no shop in scope, so we pass the current
// WORKSPACE id instead — it's stable per workspace, which is the closest
// equivalent scope here.
// ---------------------------------------------------------------------------

const ZoomPlusPage = () => {
  const workspaceService = useService(WorkspaceService);
  const workspaceId = workspaceService.workspace.id;

  const onWritesBlocked = useCallback(() => {}, []);
  const onMutated = useCallback(() => {}, []);

  return (
    <>
      <ViewTitle title="ZOOM+" />
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
          <span style={{ fontSize: 16 }}>🎥</span>
          ZOOM+
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '0 6px',
              borderRadius: 5,
              letterSpacing: '0.05em',
              color: C.muted,
              backgroundColor:
                'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
            }}
          >
            béta
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div style={{ height: '100%', width: '100%', overflow: 'auto' }}>
          <ZoomPlusPanel
            slug={workspaceId}
            readOnly={false}
            onWritesBlocked={onWritesBlocked}
            onMutated={onMutated}
          />
        </div>
      </ViewBody>
    </>
  );
};

export const Component = () => {
  return <ZoomPlusPage />;
};
