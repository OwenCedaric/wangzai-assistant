export const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function cleanText(value) {
  return String(value || "").replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

export function redactText(value) {
  return cleanText(value)
    .replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/gi, "$1…")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1***")
    .replace(/((?:api[_ -]?key|token)\s*[:=]\s*)[^\s,;]+/gi, "$1***")
    .replace(/https?:\/\/[^\s]+(?:qrcode|qrconnect)[^\s]*/gi, "[微信二维码链接已隐藏]")
    .slice(0, 4000);
}

export const PUBLIC_LOG_SCOPE_LABELS = Object.freeze({
  gateway: "微信服务",
  "model-relay": "模型通道",
  "action-relay": "操作通道",
  setup: "组件准备",
  config: "设置",
  billing: "积分",
  recovery: "连接恢复",
  "wechat-login": "微信绑定",
  error: "错误",
});

export function publicErrorMessage(value) {
  const text = redactText(value).trim();
  if (!text) return "操作没有完成，请稍后重试。";
  if (/没有当前功能的有效积分价格|积分价格暂不可用|MODEL_(?:PRESET_)?RATE_UNAVAILABLE|PAID_CAPABILITY_RATE_UNAVAILABLE/iu.test(text)) {
    return "当前模型暂未启用积分价格，本次没有调用模型，也不会扣积分；请联系管理员启用后重试。";
  }
  if (/OPENCLAW_CORE_ROUTE_UNAVAILABLE|模型服务版本尚未同步|(?:404|Not Found).*openclaw/iu.test(text)) {
    return "模型服务版本尚未同步，本次没有调用模型，也不会扣积分；请联系管理员更新服务。";
  }
  if (/This operation was aborted|AbortError|\baborted\b/iu.test(text)) {
    return "回复处理超时，本次没有自动重发，请稍后再试。";
  }
  if (/ECONNREFUSED|ETIMEDOUT|fetch failed|connection refused|connect failed/iu.test(text)) {
    return "连接暂时不可用，系统会自动恢复，请稍后再试。";
  }
  if (/selected model not found|model not found/iu.test(text)) {
    return "当前选择的模型暂不可用，请重新检查模型设置。";
  }
  if (/网关退出/u.test(text)) return "微信服务意外停止，系统正在自动恢复。";
  if (/^[^A-Za-z]*[\u3400-\u9fff]/u.test(text) && !/[A-Za-z]{3,}/u.test(text)) return text;
  return "操作没有完成，请稍后重试；详细原因已记录在本机诊断文件中。";
}

export function formatWechatAssistantPublicLogLine(value) {
  const text = cleanText(value).trim();
  if (!text) return "";
  const match = text.match(/^(\d{1,2}:\d{2}:\d{2}) \[([^\]]+)\] ([\s\S]*)$/u);
  const time = match?.[1] || "";
  const scope = match?.[2] || "error";
  const body = String(match?.[3] || text).trim();
  const prefix = time ? `${time} ` : "";
  const line = (label, message) => `${prefix}【${label}】${message}`;

  if (scope === "gateway") {
    if (/没有当前功能的有效积分价格|积分价格暂不可用|MODEL_(?:PRESET_)?RATE_UNAVAILABLE|PAID_CAPABILITY_RATE_UNAVAILABLE/iu.test(body)) {
      return line("模型通道", publicErrorMessage(body));
    }
    if (/OPENCLAW_CORE_ROUTE_UNAVAILABLE|模型服务版本尚未同步/iu.test(body)) {
      return line("模型通道", publicErrorMessage(body));
    }
    if (/weixin monitor started/iu.test(body)) return line("微信通道", "微信收信服务已启动。");
    if (/weixin getUpdates (?:error|failed|: \d+ consecutive failures)/iu.test(body)) {
      return line("微信通道", "微信收信连接失败，系统正在自动恢复。");
    }
    if (/(?:sendMessageWeixin: failed|outbound: FAILED|weixin reply .*failed)/iu.test(body)) {
      return line("微信通道", "微信回信状态待核对，本次不会自动重复发送。");
    }
    if (/weixin reply .*?(?:AbortError|This operation was aborted|\baborted\b)/iu.test(body)) {
      return line("微信通道", publicErrorMessage(body));
    }
    if (/outbound: (?:text|media) sent OK/iu.test(body)) return line("微信通道", "微信回复已发送。");
    if (/embedded run agent end:.*isError=false/iu.test(body)) return line("助理处理", "本次消息处理完成。");
    if (/embedded run agent end:.*isError=true|failover decision|lane task error|model fallback decision|failed before reply/iu.test(body)) {
      return line("助理处理", publicErrorMessage(body));
    }
    if (/^(?:网关已启动|默认端口|.+微信助理服务已自动启动|旺崽账号)/u.test(body)) {
      return line("微信服务", body);
    }
    return "";
  }

  const label = PUBLIC_LOG_SCOPE_LABELS[scope] || "运行状态";
  if (scope === "error") return line(label, publicErrorMessage(body));
  if (!/[\u3400-\u9fff]/u.test(body) || /[A-Za-z]{3,}/u.test(body)) return "";
  return line(label, body);
}

export function publicDiagnosticLogs(values = []) {
  const result = [];
  for (const value of values) {
    const line = formatWechatAssistantPublicLogLine(value);
    if (line && line !== result.at(-1)) result.push(line);
  }
  return result.slice(-80);
}

export function classifyWechatAssistantGatewayLine(scope, value) {
  if (scope !== "gateway") return null;
  const line = cleanText(value).trim();
  if (!line) return null;
  if (/weixin monitor started/iu.test(line)) return { type: "wechat-monitor-started" };
  if (/weixin getUpdates (?:error|failed|: \d+ consecutive failures)/iu.test(line)) {
    return {
      type: "wechat-poll-failure",
      terminal: /(?:\(\s*3\/3\s*\)|3 consecutive failures)/iu.test(line),
    };
  }
  if (
    /\[model-fetch\].*provider=wangzaiAssistant/iu.test(line)
    && /(?:ECONNREFUSED|connection refused|connect failed)/iu.test(line)
  ) {
    return { type: "local-model-relay-failure" };
  }
  if (/(?:sendMessageWeixin: failed|outbound: FAILED|weixin reply .*failed)/iu.test(line)) {
    return { type: "wechat-send-outcome-unknown" };
  }
  return null;
}
