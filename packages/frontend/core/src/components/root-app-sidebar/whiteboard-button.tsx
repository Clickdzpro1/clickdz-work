/**
 * Left-rail Whiteboard entry — choose a new canvas or reopen a recent board.
 */
import { Menu } from '@affine/component';
import { BlockCard } from '@affine/component/card/block-card';
import { MenuItem } from '@affine/core/modules/app-sidebar/views';
import { usePageHelper } from '@affine/core/blocksuite/block-suite-page-list/utils';
import { useAsyncCallback } from '@affine/core/components/hooks/affine-async-hooks';
import { DocsService } from '@affine/core/modules/doc';
import { TemplateDocService } from '@affine/core/modules/template-doc';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { track } from '@affine/track';
import { EdgelessIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';
import { useCallback, useMemo, useState } from 'react';

export function WhiteboardButton() {
  const workspaceService = useService(WorkspaceService);
  const templateDocService = useService(TemplateDocService);
  const docsService = useService(DocsService);
  const workbench = useService(WorkbenchService).workbench;
  const currentWorkspace = workspaceService.workspace;
  const pageHelper = usePageHelper(currentWorkspace.docCollection);
  const docRecords = useLiveData(docsService.list.docs$);
  const [open, setOpen] = useState(false);

  const recentWhiteboards = useMemo(
    () =>
      (docRecords ?? [])
        .filter(
          record =>
            !record.trash$.value && record.primaryMode$.value === 'edgeless'
        )
        .sort((a, b) => (b.updatedAt$.value ?? 0) - (a.updatedAt$.value ?? 0))
        .slice(0, 5),
    [docRecords]
  );

  const enablePageTemplate = useLiveData(
    templateDocService.setting.enablePageTemplate$
  );
  const pageTemplateDocId = useLiveData(
    templateDocService.setting.pageTemplateDocId$
  );

  const openNewWhiteboard = useAsyncCallback(async () => {
    // Always create edgeless (whiteboard), ignore page template for this entry
    if (enablePageTemplate && pageTemplateDocId) {
      // still force edgeless primary mode after duplicate if needed
      const docId = await docsService.duplicateFromTemplate(pageTemplateDocId);
      const record = docsService.list.doc$(docId).value;
      record?.setPrimaryMode('edgeless');
      workbench.openDoc(docId);
    } else {
      pageHelper.createPage('edgeless');
    }
    track.$.navigationPanel.$.createDoc();
    track.$.sidebar.newDoc.quickStart({ with: 'edgeless' });
  }, [
    docsService,
    enablePageTemplate,
    pageHelper,
    pageTemplateDocId,
    workbench,
  ]);

  const createNewWhiteboard = useCallback(() => {
    setOpen(false);
    void openNewWhiteboard();
  }, [openNewWhiteboard]);

  const openRecentWhiteboard = useCallback(
    (docId: string) => {
      setOpen(false);
      workbench.openDoc(docId);
    },
    [workbench]
  );

  return (
    <Menu
      items={
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: 300,
            padding: 8,
          }}
        >
          <BlockCard
            title="New whiteboard"
            desc="Start with a blank canvas"
            right={<EdgelessIcon width={20} height={20} />}
            onClick={createNewWhiteboard}
            data-testid="whiteboard-create-new"
          />
          <div
            style={{
              padding: '6px 8px 0',
              color: 'var(--affine-v2-text-secondary)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Recent whiteboards
          </div>
          {recentWhiteboards.length ? (
            recentWhiteboards.map(record => (
              <BlockCard
                key={record.id}
                title={record.title$.value || 'Untitled whiteboard'}
                desc="Open existing canvas"
                right={<EdgelessIcon width={20} height={20} />}
                onClick={() => openRecentWhiteboard(record.id)}
                data-testid={`whiteboard-recent-${record.id}`}
              />
            ))
          ) : (
            <div
              style={{
                padding: '10px 8px',
                color: 'var(--affine-v2-text-secondary)',
                fontSize: 12,
              }}
            >
              No recent whiteboards yet.
            </div>
          )}
        </div>
      }
      rootOptions={{ open, onOpenChange: setOpen }}
      contentOptions={{
        side: 'right',
        sideOffset: 4,
        align: 'start',
        hideWhenDetached: true,
        onInteractOutside: () => setOpen(false),
      }}
    >
      <MenuItem
        data-testid="slider-bar-whiteboard-button"
        icon={<EdgelessIcon />}
        active={open}
      >
        <span data-testid="whiteboard-nav">Whiteboard</span>
      </MenuItem>
    </Menu>
  );
}
