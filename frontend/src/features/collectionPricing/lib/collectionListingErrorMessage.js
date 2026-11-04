function text(value) {
  return String(value ?? '').trim();
}

function rawMessageOf(value) {
  if (typeof value === 'string') return text(value);
  return text(
    value?.payload?.error?.message
      || value?.error?.message
      || value?.response?.error?.message
      || value?.message,
  );
}

function errorCodeOf(value) {
  return text(
    value?.payload?.error?.code
      || value?.error?.code
      || value?.response?.error?.code
      || value?.code,
  );
}

export function normalizeCollectionListingErrorMessage(value, fallback = '上架任务执行失败。') {
  const raw = rawMessageOf(value);
  const code = errorCodeOf(value);
  const evidence = `${code} ${raw}`;
  const messages = [];

  if (/OZON_PRODUCT_DAILY_CREATION_LIMIT_EXCEEDED|periodic_limit_exceeded/iu.test(evidence)) {
    messages.push('该店铺今日的 Ozon 商品创建额度已用完，请在 Ozon 额度重置后再试。');
  }
  if (/VALUE_MUST_BE_BOOLEAN|Значение\s+должно\s+быть\s+булевым|invalid\s+value\s+for\s+string\s+field\s+value:\s*(?:true|false)/iu.test(evidence)) {
    messages.push('部分 Ozon 布尔属性的值格式错误；请重新生成预览，软件会按字符串 true/false 正确提交。');
  }
  if (/pics_PIC_limit_exceeded|Максимальное\s+количество\s+дополнительных\s+фото/iu.test(evidence)) {
    messages.push('商品图片超过 Ozon 上限：最多 1 张主图加 29 张附加图；请重新生成预览。');
  }
  if (/Company is blocked|Ozon\s+code\s+7/iu.test(evidence)) {
    messages.push('该 Ozon 店铺的公司状态已被平台限制（Ozon code 7），请联系 Ozon 客服解除；软件无法代为解封。');
  }
  if (/invalid\s+URL/iu.test(evidence)) {
    messages.push('某个图片或链接属性不是 Ozon 可访问的有效 HTTPS 地址，请返回图片与属性页重新确认。');
  }
  if (/double_without_merger_offer|Не удалось объединить с другими товарами|вариативные характеристики заполнены также/iu.test(evidence)) {
    messages.push('部分 SKU 的颜色、尺寸或款式等变体属性完全相同，Ozon 无法合并为同一商品卡；请返回类目与属性页重新执行一键分析填充后再上传。');
  }

  return [...new Set(messages)].join('；') || raw || fallback;
}
