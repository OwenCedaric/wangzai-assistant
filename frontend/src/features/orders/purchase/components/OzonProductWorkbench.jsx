import { PurchaseOrderWorkbenchDialog } from './PurchaseOrderWorkbenchDialog.jsx';

export function OzonProductWorkbench({ controller }) {
  if (!controller) return null;
  return (
    <PurchaseOrderWorkbenchDialog
      dialog={controller.dialog}
      onClose={controller.close}
      onMinimize={controller.minimize}
      onViewportReady={controller.startBrowser}
      onRetry={controller.retry}
      onNavigate={controller.navigate}
      onReadPaymentInfo={controller.readPaymentInfo}
      onRefreshOrderStatus={controller.refreshOrderStatus}
      onSavePurchaseInfo={controller.savePurchaseInfo}
    />
  );
}
