function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function cleanupText(value = '') {
  return normalizeText(value)
    .replace(/\s*[:：]\s*/g, '：')
    .replace(/\s*[;；]\s*/g, '；')
    .replace(/\s*[,，]\s*/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsCyrillic(value = '') {
  return /[\u0400-\u04FF]/u.test(String(value));
}

function containsUntranslatedLatin(value = '') {
  return /[A-Za-z]/.test(String(value).replace(/\b(Ozon|rFBS|FBS|FBO|SKU)\b/gi, ''));
}

const AFTER_SALES_REASON_TRANSLATIONS = new Map([
  ['Покупатель отказался при вручении: товар не подошел', '买家交付时拒收：商品不合适'],
  ['Покупатель отказался при вручении: товар не подошёл', '买家交付时拒收：商品不合适'],
  ['Покупатель отказался при вручении: неполная комплектация', '买家交付时拒收：商品配件不全'],
  ['Покупатель отказался при вручении: недоволен качеством товара', '买家交付时拒收：对商品质量不满意'],
  ['Покупатель отказался при вручении', '买家交付时拒收'],
  ['Покупатель отказался при получении', '买家收货时拒收'],
  ['Покупатель отказался от товара', '买家拒收商品'],
  ['Покупатель не забрал заказ', '买家未取件'],
  ['Покупатель отменил заказ по вашей просьбе', '买家应您的请求取消订单'],
  ['Покупатель отменил заказ: нашел дешевле', '买家取消订单：找到了更便宜的商品'],
  ['Покупатель отменил заказ: нашёл дешевле', '买家取消订单：找到了更便宜的商品'],
  ['Покупатель отменил заказ', '买家取消订单'],
  ['Клиент отменил заказ', '买家取消订单'],
  ['Вы отменили заказ', '卖家取消订单'],
  ['Вы не отгрузили заказ вовремя', '您未按时发货'],
  ['Вы не отправили заказ вовремя', '您未按时发货'],
  ['Товар закончился на складе', '仓库商品已售完'],
  ['Товар закончился на вашем складе', '您的仓库商品已售完'],
  ['Товар не подошел', '商品不合适'],
  ['Товар не подошёл', '商品不合适'],
  ['Не удалось доставить заказ', '未能配送商品'],
  ['Отправление не прошло таможенное оформление', '货件未通过清关'],
  ['Проверка товара на соответствие описанию в карточке', 'Ozon 检查商品是否符合商品卡描述'],
  ['Привезли не тот товар', '配送了错误的商品'],
  ['Деньги возвращены покупателю', '已向买家退款'],
  ['Утилизировано Ozon', 'Ozon 已处置/销毁'],
  ['Утилизирован Ozon', 'Ozon 已处置/销毁'],
  ['На утилизации', 'Ozon 处置中'],
  ['buyer refused', '买家拒收'],
  ['Buyer refused', '买家拒收'],
  ['buyer refused the goods at delivery', '买家交付时拒收'],
  ['Buyer refused the goods at delivery', '买家交付时拒收'],
  ['not picked up', '买家未取件'],
  ['Not picked up', '买家未取件'],
  ['buyer did not pick up', '买家未取件'],
  ['Buyer did not pick up', '买家未取件'],
  ['Utilizing', 'Ozon 处置中'],
  ['UtilizingByOzon', 'Ozon 处置中'],
  ['UtilizedByOzon', 'Ozon 已处置/销毁'],
  ['Utilized', 'Ozon 已处置/销毁'],
  ['MoneyReturned', '已退款给买家'],
  ['PartialCompensationReturnedByOzon', 'Ozon 已部分补偿'],
  ['utilized_by_ozon', 'Ozon 已处置/销毁'],
  ['ReturnDisposed', 'Ozon 已处置/销毁'],
  ['ReturnedToSeller', '已退回卖家'],
  ['ReturningToSeller', '退回卖家中'],
  ['disposed', 'Ozon 已处置/销毁'],
  ['destroyed', 'Ozon 已处置/销毁'],
  ['You did not ship on time', '未按时发货'],
  ['仓库商品已售完', '仓库商品已售完'],
  ['Other', '其他售后原因'],
  ['other', '其他售后原因'],
  ['unknown', '其他售后原因'],
  ['Unknown', '其他售后原因'],
]);

const AFTER_SALES_REASON_PATTERNS = [
  [/Покупатель\s+отказался\s+при\s+вручении/gi, '买家交付时拒收'],
  [/Покупатель\s+отказался\s+при\s+получении/gi, '买家收货时拒收'],
  [/Покупатель\s+отказался\s+от\s+товар[а-яё]*/gi, '买家拒收商品'],
  [/Покупатель\s+не\s+забрал\s+заказ/gi, '买家未取件'],
  [/Покупатель\s+отменил\s+заказ\s+по\s+вашей\s+просьбе/gi, '买家应您的请求取消订单'],
  [/Покупатель\s+отменил\s+заказ/gi, '买家取消订单'],
  [/Клиент\s+отменил\s+заказ/gi, '买家取消订单'],
  [/Вы\s+отменили\s+заказ/gi, '卖家取消订单'],
  [/наш[её]л\s+дешевле/gi, '找到了更便宜的商品'],
  [/неполная\s+комплектация/gi, '商品配件不全'],
  [/недоволен\s+качеством\s+товара/gi, '对商品质量不满意'],
  [/товар\s+не\s+подош[её]л/gi, '商品不合适'],
  [/не\s+подош[её]л\s+размер/gi, '尺码不合适'],
  [/не\s+подош[её]л(?:а|о)?/gi, '不合适'],
  [/Покупатель\s+отказался/gi, '买家拒收'],
  [/не\s+забрал(?:и)?\s+заказ/gi, '买家未取件'],
  [/Ист[её]к\s+срок\s+хранения/gi, '超过取件/保管期限'],
  [/товар\s+поврежд[её]н/gi, '商品损坏'],
  [/поврежд[её]н(?:ный|ная|ное)?\s+товар/gi, '商品损坏'],
  [/брак(?:ованный|ованная|ованное)?\s+товар/gi, '商品有瑕疵'],
  [/Вы\s+не\s+отгрузили\s+заказ\s+вовремя/gi, '您未按时发货'],
  [/Вы\s+не\s+отправили\s+заказ\s+вовремя/gi, '您未按时发货'],
  [/Товар\s+закончился\s+на\s+вашем\s+складе/gi, '您的仓库商品已售完'],
  [/Товар\s+закончился\s+на\s+складе/gi, '仓库商品已售完'],
  [/Не\s+удалось\s+доставить\s+заказ/gi, '未能配送商品'],
  [/Не\s+удалось\s+доставить/gi, '未能配送商品'],
  [/Отправлени[ея]\s+не\s+прошл[оа]\s+таможенн[а-яё]+\s+оформлени[ея]/gi, '货件未通过清关'],
  [/Проверка\s+товар[а-яё]*\s+на\s+соответстви[ея]\s+описани[яю]\s+в\s+карточк[ея]/gi, 'Ozon 检查商品是否符合商品卡描述'],
  [/Привезли\s+не\s+тот\s+товар/gi, '配送了错误的商品'],
  [/Деньги\s+возвращены\s+покупателю/gi, '已向买家退款'],
  [/Утилизирован(?:о|а)?\s+Ozon/gi, 'Ozon 已处置/销毁'],
  [/На\s+утилизации/gi, 'Ozon 处置中'],
  [/buyer\s+refused\s+the\s+goods\s+at\s+delivery/gi, '买家交付时拒收'],
  [/buyer\s+refused/gi, '买家拒收'],
  [/not\s+picked\s+up/gi, '买家未取件'],
  [/buyer\s+did\s+not\s+pick\s+up/gi, '买家未取件'],
  [/you\s+did\s+not\s+ship\s+on\s+time/gi, '未按时发货'],
  [/did\s+not\s+ship/gi, '未按时发货'],
  [/not\s+shipped/gi, '未发货'],
  [/UtilizedByOzon|utilized_by_ozon/gi, 'Ozon 已处置/销毁'],
  [/UtilizingByOzon|Utilizing/gi, 'Ozon 处置中'],
  [/disposed|destroyed/gi, 'Ozon 已处置/销毁'],
];

const AFTER_SALES_LOGISTICS_TRANSLATIONS = new Map([
  ['Utilizing', 'Ozon 处置中'],
  ['UtilizingByOzon', 'Ozon 处置中'],
  ['UtilizedByOzon', 'Ozon 已处置/销毁'],
  ['utilized_by_ozon', 'Ozon 已处置/销毁'],
  ['disposed', 'Ozon 已处置/销毁'],
  ['destroyed', 'Ozon 已处置/销毁'],
  ['delivering', '派送中'],
  ['shipped', '已发货'],
  ['shipping', '运输中'],
  ['in_transit', '运输中'],
  ['delivered', '已送达'],
  ['cancelled', '已取消'],
  ['canceled', '已取消'],
  ['not picked up', '买家未取件'],
  ['buyer refused', '买家拒收'],
]);

const AFTER_SALES_LOGISTICS_PATTERNS = [
  [/UtilizedByOzon|utilized_by_ozon/gi, 'Ozon 已处置/销毁'],
  [/UtilizingByOzon|Utilizing/gi, 'Ozon 处置中'],
  [/disposed|destroyed/gi, 'Ozon 已处置/销毁'],
  [/delivering|out\s*for\s*delivery/gi, '派送中'],
  [/in[_\s-]*transit|shipping/gi, '运输中'],
  [/\bshipped\b/gi, '已发货'],
  [/\bdelivered\b/gi, '已送达'],
  [/\bcancell?ed\b|\bcancel\b/gi, '已取消'],
  [/Покупатель\s+отказался/gi, '买家拒收'],
  [/не\s+забрал(?:и)?\s+заказ/gi, '买家未取件'],
  [/Утилизирован(?:о|а)?\s+Ozon/gi, 'Ozon 已处置/销毁'],
  [/На\s+утилизации/gi, 'Ozon 处置中'],
];

export function translateAfterSalesReasonToChinese(value = '') {
  const text = cleanupText(value);
  if (!text) return '';
  const exact = AFTER_SALES_REASON_TRANSLATIONS.get(text);
  if (exact) return exact;

  let translated = text;
  AFTER_SALES_REASON_PATTERNS.forEach(([pattern, label]) => {
    translated = translated.replace(pattern, label);
  });
  translated = cleanupText(translated);
  if (!containsCyrillic(translated) && !containsUntranslatedLatin(translated)) return translated;

  // Never replace an Ozon reason with a generic label. If a new platform reason
  // has not entered the deterministic catalog yet, preserve the exact source text.
  return text;
}

export function translateAfterSalesLogisticsStatusToChinese(value = '') {
  const text = cleanupText(value);
  if (!text) return '';
  const exact = AFTER_SALES_LOGISTICS_TRANSLATIONS.get(text);
  if (exact) return exact;

  let translated = text;
  AFTER_SALES_LOGISTICS_PATTERNS.forEach(([pattern, label]) => {
    translated = translated.replace(pattern, label);
  });
  translated = cleanupText(translated);
  if (!containsCyrillic(translated) && !containsUntranslatedLatin(translated)) return translated;
  return text;
}

export function getAfterSalesChineseText(value = '') {
  return translateAfterSalesReasonToChinese(value) || translateAfterSalesLogisticsStatusToChinese(value);
}
