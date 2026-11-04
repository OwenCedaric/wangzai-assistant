const ENDPOINTS = {
  'auth.queryAuthorization': {
    key: 'auth.queryAuthorization',
    risk: 'read',
    method: 'POST',
    path: '/erpapi/user/queryauthorization',
    bodyFormat: 'form',
    timeoutMs: 15000,
    description: '查询跨境巴士授权状态。',
  },
  'warehouse.cooperationStorehouse': {
    key: 'warehouse.cooperationStorehouse',
    risk: 'read',
    method: 'POST',
    path: '/erpapi/storehouse/cooperationStorehouse',
    bodyFormat: 'form',
    timeoutMs: 15000,
    description: '查询合作仓库。',
  },
  'warehouse.searchStorehouseSection': {
    key: 'warehouse.searchStorehouseSection',
    risk: 'read',
    method: 'POST',
    path: '/erpapi/storehouse/searchStorehouseSection',
    bodyFormat: 'form',
    timeoutMs: 15000,
    description: '查询仓区。',
  },
  'order.search': {
    key: 'order.search',
    risk: 'read',
    method: 'POST',
    path: '/erpapi/orderlist/search',
    bodyFormat: 'form',
    timeoutMs: 15000,
    description: '搜索跨境巴士订单。',
  },
  'order.status': {
    key: 'order.status',
    risk: 'read',
    method: 'POST',
    path: '/erpapi/orderlist/status',
    bodyFormat: 'form',
    timeoutMs: 15000,
    description: '读取跨境巴士订单状态。',
  },
  'order.outInfo': {
    key: 'order.outInfo',
    risk: 'read',
    method: 'POST',
    path: '/erpapi/order/get_order_out_info',
    bodyFormat: 'form',
    timeoutMs: 15000,
    description: '读取跨境巴士出库/包裹/材积信息。',
  },
  'order.create': {
    key: 'order.create',
    risk: 'write',
    method: 'POST',
    path: '/erpapi/order/createOrder',
    bodyFormat: 'json',
    timeoutMs: 20000,
    description: '创建跨境巴士预报订单，默认禁止执行。',
  },
  'order.update': {
    key: 'order.update',
    risk: 'write',
    method: 'POST',
    path: '/erpapi/order/updateOrder',
    bodyFormat: 'form',
    timeoutMs: 20000,
    description: '更新跨境巴士订单，默认禁止执行。',
  },
  'order.updateSheet': {
    key: 'order.updateSheet',
    risk: 'write',
    method: 'POST',
    path: '/erpapi/order/updateOrderSheet',
    bodyFormat: 'form',
    timeoutMs: 20000,
    description: '更新跨境巴士面单，默认禁止执行。',
  },
  'order.updatePackage': {
    key: 'order.updatePackage',
    risk: 'write',
    method: 'POST',
    path: '/erpapi/order/updateOrderPackage',
    bodyFormat: 'form',
    timeoutMs: 20000,
    description: '更新跨境巴士包裹，默认禁止执行。',
  },
  'order.cancel': {
    key: 'order.cancel',
    risk: 'write',
    method: 'POST',
    path: '/erpapi/order/cancelOrder',
    bodyFormat: 'form',
    timeoutMs: 20000,
    description: '废弃跨境巴士订单，默认禁止执行。',
  },
  'order.syncStatus': {
    key: 'order.syncStatus',
    risk: 'write',
    method: 'POST',
    path: '/erpapi/ordersync/order_update',
    bodyFormat: 'json',
    timeoutMs: 20000,
    description: '按订单ID同步平台订单状态，默认禁止执行。',
  },
  'order.associate': {
    key: 'order.associate',
    risk: 'write',
    method: 'POST',
    path: '/erpapi/orderassociation/association_order_account',
    bodyFormat: 'json',
    timeoutMs: 20000,
    description: '关联手工订单与平台订单并同步商品、物流信息，默认禁止执行。',
  },
};

export function getCrossBorderEndpoint(endpointKey) {
  return ENDPOINTS[endpointKey] || null;
}

export function listCrossBorderEndpoints() {
  return Object.values(ENDPOINTS).map((endpoint) => ({ ...endpoint }));
}

export function assertCrossBorderReadEndpoint(endpointKey) {
  const endpoint = getCrossBorderEndpoint(endpointKey);
  if (!endpoint) {
    const error = new Error(`Cross-border endpoint is not registered: ${endpointKey}`);
    error.code = 'CROSS_BORDER_ENDPOINT_NOT_REGISTERED';
    throw error;
  }
  if (endpoint.risk !== 'read') {
    const error = new Error(`Cross-border endpoint is not read-only: ${endpointKey}`);
    error.code = 'CROSS_BORDER_WRITE_ENDPOINT_BLOCKED';
    throw error;
  }
  return endpoint;
}

export function assertCrossBorderWriteEndpoint(endpointKey) {
  const endpoint = getCrossBorderEndpoint(endpointKey);
  if (!endpoint) {
    const error = new Error(`Cross-border endpoint is not registered: ${endpointKey}`);
    error.code = 'CROSS_BORDER_ENDPOINT_NOT_REGISTERED';
    throw error;
  }
  if (endpoint.risk !== 'write') {
    const error = new Error(`Cross-border endpoint is not a write endpoint: ${endpointKey}`);
    error.code = 'CROSS_BORDER_WRITE_ENDPOINT_REQUIRED';
    throw error;
  }
  return endpoint;
}
