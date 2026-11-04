import { usePurchaseOrdersPageModel } from './model/usePurchaseOrdersPageModel.jsx';
import { PurchaseOrdersPageView } from './view/PurchaseOrdersPageView.jsx';

function PurchaseOrdersPage(props) {
  const model = usePurchaseOrdersPageModel(props);
  return <PurchaseOrdersPageView model={model} />;
}

export default PurchaseOrdersPage;
