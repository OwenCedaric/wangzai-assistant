import { CustomerConsultationDetailPanel } from './components/CustomerConsultationDetailPanel.jsx';
import { CustomerConsultationTopStatusBar } from './components/CustomerConsultationTopStatusBar.jsx';
import { CustomerConversationList } from './components/CustomerConversationList.jsx';
import { CustomerConversationThread } from './components/CustomerConversationThread.jsx';
import { CustomerMessageComposer } from './components/CustomerMessageComposer.jsx';
import { CustomerMessageSendDialog } from './components/CustomerMessageSendDialog.jsx';
import { CustomerFileSendDialog } from './components/CustomerFileSendDialog.jsx';
import { CustomerConversationStartDialog } from './components/CustomerConversationStartDialog.jsx';
import { CustomerMarkAllReadDialog } from './components/CustomerMarkAllReadDialog.jsx';
import { CustomerQuickRepliesPanel } from './components/CustomerQuickRepliesPanel.jsx';
import { useCustomerConsultationPageModel } from './model/useCustomerConsultationPageModel.js';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import React from 'react';

export function CustomerConsultationPage({
  shops = [],
  activeShopId = '',
  isActive = true,
  onActiveShopChange,
  openTarget = null,
  onUnreadChange,
}) {
  const pageModel = useCustomerConsultationPageModel({ shops, activeShopId, isActive, openTarget });

  React.useEffect(() => {
    if (!isActive || !activeShopId) return;
    onUnreadChange?.(pageModel.globalUnreadSnapshot);
  }, [activeShopId, isActive, onUnreadChange, pageModel.globalUnreadSnapshot]);

  return (
    <Box className="customer-consultation-page">
      <CustomerConsultationTopStatusBar
        shops={shops}
        activeShopId={activeShopId}
        onActiveShopChange={onActiveShopChange}
        syncLabel={pageModel.syncLabel}
        syncTone={pageModel.syncTone}
        stats={pageModel.stats}
        shopProfile={pageModel.shopProfile}
      />

      <Card className="customer-consultation-workspace">
        <Box className={`customer-chat-layout${pageModel.quickReplies.open ? ' quick-replies-open' : ''}`}>
          <CustomerConversationList {...pageModel.conversationListProps} />

          <Box className="customer-chat-main-panel">
            <CustomerConversationThread {...pageModel.threadProps} />
            <CustomerMessageComposer {...pageModel.composerProps} />
          </Box>

          {pageModel.quickReplies.open ? (
            <CustomerQuickRepliesPanel
              phrases={pageModel.quickReplies.visiblePhrases}
              searchText={pageModel.quickReplies.searchText}
              newPhraseText={pageModel.quickReplies.newPhraseText}
              onSearchChange={pageModel.quickReplies.setSearchText}
              onNewPhraseChange={pageModel.quickReplies.setNewPhraseText}
              onAddPhrase={pageModel.quickReplies.addPhrase}
              onRemovePhrase={pageModel.quickReplies.removePhrase}
              onUsePhrase={pageModel.handleUseQuickReply}
              onClose={() => pageModel.quickReplies.setOpen(false)}
            />
          ) : (
            <CustomerConsultationDetailPanel {...pageModel.detailPanelProps} />
          )}
        </Box>
      </Card>

      <CustomerMessageSendDialog
        state={pageModel.sendState}
        onClose={pageModel.closeSend}
        onConfirm={pageModel.confirmSend}
        onRetryReadback={pageModel.retrySendReadback}
      />
      <CustomerMarkAllReadDialog
        state={pageModel.markAllReadState}
        onClose={pageModel.closeMarkAllRead}
        onConfirm={pageModel.confirmMarkAllRead}
      />
      <CustomerFileSendDialog
        state={pageModel.fileSendState}
        onClose={pageModel.closeFileSend}
        onConfirm={pageModel.confirmFileSend}
        onRetryReadback={pageModel.retryFileReadback}
      />
      <CustomerConversationStartDialog
        state={pageModel.startState}
        onClose={pageModel.closeStart}
        onChange={pageModel.setPostingNumber}
        onPreview={pageModel.requestStart}
        onConfirm={pageModel.confirmStart}
        onRetryReadback={pageModel.retryStartReadback}
      />
      <Snackbar
        open={Boolean(pageModel.newMessageAlert)}
        autoHideDuration={6000}
        onClose={pageModel.closeNewMessageAlert}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Alert severity="info" onClose={pageModel.closeNewMessageAlert} variant="filled">
          {pageModel.newMessageAlert?.message || ''}
        </Alert>
      </Snackbar>
    </Box>
  );
}
