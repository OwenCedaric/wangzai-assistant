import { useSalesOrdersPageModel } from './model/useSalesOrdersPageModel.jsx';
import { SalesOrdersPageView } from './view/SalesOrdersPageView.jsx';

function SalesOrdersPage(props) {
  const model = useSalesOrdersPageModel(props);
  return <SalesOrdersPageView model={model} />;
}

export default SalesOrdersPage;
