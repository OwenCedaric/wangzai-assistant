import { firstFiniteNumber, toFiniteNumber } from '../product/productAttributes.jsx';
import { firstFilled } from './orderIdentityRules.jsx';

export function getOzonProductRawSalesAmount(raw = {}, qty = 1) {
  const explicitTotal = firstFiniteNumber(
    raw.total_price,
    raw.totalPrice,
    raw.total_amount,
    raw.totalAmount,
    raw.row_price,
    raw.rowPrice,
    raw.line_price,
    raw.linePrice,
    raw.final_price,
    raw.finalPrice
  );
  if (explicitTotal !== null) return explicitTotal;

  const unitPrice = firstFiniteNumber(
    raw.price?.price,
    raw.price,
    raw.offer_price,
    raw.offerPrice,
    raw.item_price,
    raw.itemPrice
  );
  return unitPrice === null ? null : unitPrice * qty;
}

export function getOzonOrderProductSalesAmount(product = {}) {
  const qty = toFiniteNumber(firstFilled(product.qty, product.quantity, product.count)) ?? 1;
  const financialRaw = product.financialRaw ?? {};
  const financialAmount = getOzonProductRawSalesAmount(financialRaw, qty);
  if (financialAmount !== null) return financialAmount;

  const raw = product.raw ?? {};
  const rawAmount = getOzonProductRawSalesAmount(raw, qty);
  if (rawAmount !== null) return rawAmount;

  const unitPrice = toFiniteNumber(firstFilled(product.priceValue, product.price, product.amountValue, product.amount));
  return unitPrice === null ? null : unitPrice * qty;
}
