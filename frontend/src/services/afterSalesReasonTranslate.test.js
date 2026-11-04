import { describe, expect, it } from 'vitest';
import {
  translateAfterSalesLogisticsStatusToChinese,
  translateAfterSalesReasonToChinese,
} from './afterSalesReasonTranslate';

describe('after-sales reason translation', () => {
  it.each([
    ['Покупатель отказался при вручении', '买家交付时拒收'],
    ['Покупатель отказался при вручении: товар не подошел', '买家交付时拒收：商品不合适'],
    ['Покупатель отказался при вручении: неполная комплектация', '买家交付时拒收：商品配件不全'],
    ['Покупатель отказался при вручении: недоволен качеством товара', '买家交付时拒收：对商品质量不满意'],
    ['Покупатель отменил заказ по вашей просьбе', '买家应您的请求取消订单'],
    ['Покупатель отменил заказ: нашел дешевле', '买家取消订单：找到了更便宜的商品'],
    ['Товар не подошёл', '商品不合适'],
    ['Привезли не тот товар', '配送了错误的商品'],
    ['buyer refused', '买家拒收'],
    ['not picked up', '买家未取件'],
    ['Utilizing', 'Ozon 处置中'],
    ['UtilizedByOzon', 'Ozon 已处置/销毁'],
    ['You did not ship on time', '未按时发货'],
    ['仓库商品已售完', '仓库商品已售完'],
    ['Не удалось доставить заказ', '未能配送商品'],
    ['Отправление не прошло таможенное оформление', '货件未通过清关'],
    ['Проверка товара на соответствие описанию в карточке', 'Ozon 检查商品是否符合商品卡描述'],
    ['Other', '其他售后原因'],
    ['Unmapped raw reason', 'Unmapped raw reason'],
    ['Неизвестная новая причина', 'Неизвестная новая причина'],
  ])('translates %s to %s', (raw, expected) => {
    expect(translateAfterSalesReasonToChinese(raw)).toBe(expected);
  });

  it.each([
    ['Utilizing', 'Ozon 处置中'],
    ['UtilizedByOzon', 'Ozon 已处置/销毁'],
    ['disposed', 'Ozon 已处置/销毁'],
    ['delivering', '派送中'],
    ['shipped', '已发货'],
  ])('translates logistics status %s to %s', (raw, expected) => {
    expect(translateAfterSalesLogisticsStatusToChinese(raw)).toBe(expected);
  });
});
