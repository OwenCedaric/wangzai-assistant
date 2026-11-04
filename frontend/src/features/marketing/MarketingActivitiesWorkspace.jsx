import { useMarketingActivitiesPageModel } from './model/useMarketingActivitiesPageModel.jsx';
import { MarketingActivitiesPageView } from './view/MarketingActivitiesPageView.jsx';

function MarketingActivityPage(props) {
  const model = useMarketingActivitiesPageModel(props);
  return <MarketingActivitiesPageView model={model} />;
}

export default MarketingActivityPage;
