import { fixedMarketingActivityTitleById, normalizeOzonId } from '../order/orderShopScope.jsx';
import {
  getMarketingActionSearchText,
  isMarketingElasticAction,
  isMarketingNoLimitElasticAction,
} from './marketingSnapshotRuntime.jsx';

export function isMarketingSellerAddedAction(action = {}) {
  const actionId = normalizeOzonId(
    action.id ?? action.action_id ?? action.actionId ?? action.raw?.id ?? action.raw?.action_id
  );
  if (actionId === '60564') return true;
  return isMarketingNoLimitElasticAction(action);
}

export function normalizeMarketingAddMode(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (!text) return 'unknown';
  if (/(平台|自动|auto|automatic|platform|system|ozon|авто|автомат|систем)/i.test(text)) return 'platform';
  if (/(商家|自主|手动|manual|seller|merchant|hand|self|own|вручн|продав)/i.test(text)) return 'seller';
  if (/(混合|mixed|both|mix|смес)/i.test(text)) return 'mixed';
  return 'unknown';
}

export function getMarketingAddModeLabel(mode, short = true) {
  const normalized = normalizeMarketingAddMode(mode);
  if (normalized === 'platform') return short ? '平台自动' : '平台自动添加';
  if (normalized === 'seller') return short ? '商家自主' : '商家自主添加';
  if (normalized === 'mixed') return short ? '混合添加' : '混合添加';
  return short ? '未确认' : '未读取添加方式';
}

export function getMarketingAddModeTone(mode) {
  const normalized = normalizeMarketingAddMode(mode);
  if (normalized === 'seller') return 'success';
  if (normalized === 'platform') return 'primary';
  if (normalized === 'mixed') return 'warning';
  return 'default';
}

export function translateMarketingActivityType(action = {}) {
  const text = getMarketingActionSearchText(action);
  if (/(супербустинг|super\s*boost|superboost)/i.test(text)) return '超级提升';
  if (/(最大|maximum|max|максимал)/i.test(text)) return '最大提升';
  if (isMarketingElasticAction(action)) return '弹性提升';
  if (/(库存|stock|inventory|остат|склад)/i.test(text)) return '库存折扣';
  if (/(wow|вау)/i.test(text)) return 'WOW价格精选';
  if (/(school|учеб|школ)/i.test(text)) return '学校用品';
  if (/(voucher|coupon|купон|промокод)/i.test(text)) return '优惠券';
  if (/(hit|hits|хит)/i.test(text)) return '热卖精选';
  if (/(global|world|глобал|всемир)/i.test(text)) return '全球促销';
  if (/(discount|sale|скид|акци)/i.test(text)) return '活动折扣';
  return '活动';
}

export function translateMarketingActivityTitle(action = {}) {
  const fixedTitle =
    fixedMarketingActivityTitleById[
      normalizeOzonId(
        action.id ??
          action.action_id ??
          action.seller_action_id ??
          action.actionId ??
          action.raw?.id ??
          action.raw?.action_id
      )
    ];
  if (fixedTitle) return fixedTitle;
  const type = translateMarketingActivityType(action);
  if (type === '弹性提升' && isMarketingNoLimitElasticAction(action)) return '弹性提升 · 长期';
  if (type === '学校用品') return '学校用品折扣';
  if (type === '热卖精选') return '热卖精选活动';
  if (type === '全球促销') return '全球促销活动';
  return type;
}

export function getMarketingActivityDescription(action = {}) {
  const type = translateMarketingActivityType(action);
  if (type === '弹性提升') return '适合稳定长期促销，优先处理已选择商品。';
  if (type === '超级提升') return '适合提高商品曝光，优先关注库存和活动价。';
  if (type === '最大提升') return '适合冲刺更高活动曝光，需重点复核价格。';
  if (type === '库存折扣') return '适合快速清理库存，关注库存深度。';
  if (type === '学校用品') return '适合学校用品相关活动，关注类目和库存。';
  if (type === '优惠券') return '适合优惠券活动，提交前复核活动价。';
  if (type === '热卖精选') return '适合热卖商品加速转化，优先处理主推商品。';
  if (type === '全球促销') return '适合大促活动，需重点复核价格和库存。';
  return '从 Ozon 后台读取活动，按本地规则展示中文名称。';
}
