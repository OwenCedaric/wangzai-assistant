import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(
  desktopRoot,
  "openclaw-runtime",
  "node_modules",
  "@tencent-weixin",
  "openclaw-weixin",
);
const targets = [
  path.join(pluginRoot, "src", "messaging", "process-message.ts"),
  path.join(pluginRoot, "dist", "src", "messaging", "process-message.js"),
];
const unsafeNotice = 'notice = `⚠️ 消息发送失败：${errMsg}`;';
const safeMarker = "WANGZAI_SAFE_REPLY_NOTICE";
const checkOnly = process.argv.includes("--check");

function safeReplacement(indent) {
  return [
    `${indent}// ${safeMarker}: never expose internal/English runtime errors to WeChat users.`,
    `${indent}notice = /(?:AbortError|This operation was aborted|\\baborted\\b)/iu.test(errMsg)`,
    `${indent}  ? \`⚠️ 回复处理超时，本次没有自动重发，请稍后再试。\``,
    `${indent}  : \`⚠️ 助理暂时无法完成回复，请稍后再试。\`;`,
  ].join("\n");
}

for (const target of targets) {
  if (!fs.existsSync(target)) throw new Error(`微信组件运行文件不存在：${target}`);
  const source = fs.readFileSync(target, "utf8");
  const alreadySafe = source.includes(safeMarker) && !source.includes(unsafeNotice);
  if (checkOnly) {
    if (!alreadySafe) throw new Error(`微信组件中文错误补丁尚未应用：${target}`);
    continue;
  }
  if (alreadySafe) continue;
  const lines = source.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(unsafeNotice));
  if (index < 0) {
    throw new Error(`微信组件错误提示结构已经变化，需要人工复核：${target}`);
  }
  const indent = lines[index].match(/^\s*/u)?.[0] || "";
  lines.splice(index, 1, safeReplacement(indent));
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
}

console.log(checkOnly ? "微信组件中文错误补丁校验通过。" : "微信组件中文错误补丁已应用。");
