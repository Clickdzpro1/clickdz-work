import { WorkbenchService } from '@affine/core/modules/workbench';
import { useLiveData, useService } from '@toeverything/infra';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';

import { IslandContainer } from './container';
import { AIIcon } from './icons';
import { aiIslandBtn, aiIslandWrapper, toolStyle } from './styles.css';

const hideChat: Array<string | ((path: string) => boolean)> = [
  '/chat',
  path => path.includes('attachments'),
  // WS-MAXP: WhatsApp Max ships its own AI assistant in the composer — the
  // floating island sat exactly on top of the send/mic button (bottom-right
  // overlap), covering it whenever a message was typed.
  path => path.includes('/whatsappmax'),
  // ZOOM+ hosts a full-bleed meeting iframe whose own controls live in the
  // same corner — keep the island out of the call surface.
  path => path.includes('/zoomplus'),
];

export const AIIsland = () => {
  // to make sure ai island is hidden first and animate in
  const [hide, setHide] = useState(true);

  const workbench = useService(WorkbenchService).workbench;
  const activeView = useLiveData(workbench.activeView$);
  const haveChatTab = useLiveData(
    activeView.sidebarTabs$.map(tabs => tabs.some(t => t.id === 'chat'))
  );
  const activeLocation = useLiveData(activeView.location$);
  const activeTab = useLiveData(activeView.activeSidebarTab$);
  const sidebarOpen = useLiveData(workbench.sidebarOpen$);

  useEffect(() => {
    let hide = true;
    if (haveChatTab) {
      hide = !!sidebarOpen && activeTab?.id === 'chat';
    } else {
      const path = activeLocation.pathname;
      hide = hideChat.some(item =>
        typeof item === 'string' ? path === item : item(path)
      );
    }
    setHide(hide);
  }, [activeLocation.pathname, activeTab, haveChatTab, sidebarOpen]);

  const onOpenChat = useCallback(() => {
    if (hide) return;
    if (haveChatTab) {
      workbench.openSidebar();
      activeView.activeSidebarTab('chat');
    } else {
      workbench.open('/chat');
      workbench.closeSidebar();
    }
  }, [activeView, haveChatTab, hide, workbench]);

  return (
    <IslandContainer className={clsx(toolStyle, { hide })}>
      <div className={aiIslandWrapper} data-hide={hide}>
        <button
          className={aiIslandBtn}
          data-testid="ai-island"
          onClick={onOpenChat}
        >
          <AIIcon />
        </button>
      </div>
    </IslandContainer>
  );
};
