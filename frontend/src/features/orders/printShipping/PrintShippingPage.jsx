import { useSalesOrdersPageModel } from '../sales/model/useSalesOrdersPageModel.jsx';
import { PrintShippingPageView } from './view/PrintShippingPageView.jsx';
import { DEFAULT_PRINT_SHIPPING_FILTERS } from './lib/printShippingFilters.js';
import React from 'react';

function PrintShippingPage(props) {
  const [printShippingFilters, setPrintShippingFilters] = React.useState(DEFAULT_PRINT_SHIPPING_FILTERS);
  const model = useSalesOrdersPageModel({
    ...props,
    initialStatus: '等待发货',
    viewTitle: '打单发货',
    viewDescription: '集中查看待打单订单、国内采购物流和 Ozon 物流信息',
    printShippingFilters,
    includePrintShippingFacets: true,
  });
  return (
    <PrintShippingPageView
      model={{
        ...model,
        printShippingFilters,
        setPrintShippingFilters,
      }}
    />
  );
}

export { PrintShippingPage };
export default PrintShippingPage;
