# Profit report domain

`profit-report` 是利润核算下的独立只读财务报表领域，不参与冻结的订单利润公式。

## 数据源

- `POST /v1/finance/cash-flow-statement/list`：结算周期、期初/期末余额、应计结算、销售、退货和服务明细。
- `POST /v1/finance/balance`：当前店铺余额；接口不可用或未返回金额时保持 `null`。

## 本地接口

```text
GET  /api/cache/profit-report
POST /api/sync/profit-report
```

所有金额保留 Ozon 原币和正负号。缺失字段必须保持 `null`，禁止用流水净额或 `0` 补造。
