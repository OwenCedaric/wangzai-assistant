function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function pointsError(message, code = "POINTS_WALLET_UNAVAILABLE", status = 503) {
  const error = new Error(message);
  error.publicMessage = message;
  error.code = code;
  error.status = status;
  return error;
}

function publicPointsReadFailure(result = {}) {
  const raw = String(result?.error || "").trim();
  if (/point.*reservation.*(?:counter|allocation).*inconsistent/iu.test(raw)) {
    return {
      code: "POINTS_RESERVATION_COUNTER_INCONSISTENT",
      message: "积分预留账校验不一致，系统已停止模型扣费；请联系管理员修复积分账后重试。",
    };
  }
  return {
    code: Number(result?.status) === 401
      ? "POINTS_LOGIN_REQUIRED"
      : "POINTS_CHECK_FAILED",
    message: raw || "无法核验当前账户积分，暂时不能使用旺崽内置能力。",
  };
}

export function normalizePaidCapabilityPointsWallet(payload = {}) {
  const balancePoints = nonnegativeInteger(
    payload.balance_points ?? payload.balancePoints,
  );
  const reservedPoints =
    nonnegativeInteger(payload.reserved_points ?? payload.reservedPoints) ?? 0;
  const explicitAvailable = nonnegativeInteger(
    payload.available_points ?? payload.availablePoints,
  );
  if (balancePoints === null) {
    throw pointsError(
      "积分账户返回的数据无效，暂时不能使用旺崽内置能力。",
      "POINTS_WALLET_INVALID",
      502,
    );
  }
  const availablePoints =
    explicitAvailable ?? Math.max(0, balancePoints - reservedPoints);
  return {
    balancePoints,
    reservedPoints,
    availablePoints,
    checkedAt: new Date().toISOString(),
  };
}

export function assertPaidCapabilityPointsAvailable(wallet = {}) {
  if (Number(wallet.availablePoints) <= 0) {
    throw pointsError(
      "当前账户可用积分为 0，无法使用旺崽内置能力；请充值积分后重试。",
      "POINT_BALANCE_INSUFFICIENT",
      402,
    );
  }
  return wallet;
}

export function createPaidCapabilityPointsReader({ licenseRuntime } = {}) {
  return async function readPaidCapabilityPointsWallet() {
    if (typeof licenseRuntime?.request !== "function") {
      throw pointsError("积分账户校验尚未初始化，请重启旺崽助手。", "POINTS_CHECK_NOT_READY");
    }
    const result = await licenseRuntime.request({
      method: "GET",
      path: "/api/points/wallet",
    });
    if (!result?.ok) {
      const failure = publicPointsReadFailure(result);
      throw pointsError(
        failure.message,
        failure.code,
        Number(result?.status) || 503,
      );
    }
    return normalizePaidCapabilityPointsWallet(result.data || {});
  };
}
