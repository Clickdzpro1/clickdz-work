/**
 * Left-rail Whiteboard entry — one click creates a brand-new edgeless board.
 */
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
import { useCallback } from 'react';

export function WhiteboardButton() {
  const workspaceService = useService(WorkspaceService);
  const templateDocService = useService(TemplateDocService);
  const docsService = useService(DocsService);
  const workbench = useService(WorkbenchService).workbench;
  const currentWorkspace = workspaceService.workspace;
  const pageHelper = usePageHelper(currentWorkspace.docCollection);

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

  const onClick = useCallback(() => {
    void openNewWhiteboard();
  }, [openNewWhiteboard]);

  return (
    <MenuItem
      data-testid="slider-bar-whiteboard-button"
      icon={<EdgelessIcon />}
      onClick={onClick}
    >
      <span data-testid="whiteboard-nav">Whiteboard</span>
    </MenuItem>
  );
}
