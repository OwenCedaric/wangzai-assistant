import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(
  new URL("./productAtomicActivationProcess.js", import.meta.url),
);

function normalizeText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function resolveProductAtomicActivationDatabase(db) {
  if (!db?.prepare) return null;
  try {
    const database = db
      .prepare("PRAGMA database_list;")
      .all()
      .find((entry) => normalizeText(entry.name) === "main");
    const path = normalizeText(database?.file);
    if (!path || path === ":memory:") return null;
    const busyTimeout = db.prepare("PRAGMA busy_timeout;").get();
    return {
      path,
      // WAL is persistent on the database file. Avoid issuing journal-mode
      // transition PRAGMAs from the child while the parent is serving reads.
      enableWal: false,
      busyTimeoutMs: Math.max(
        1_000,
        Number(busyTimeout?.timeout ?? busyTimeout?.busy_timeout) || 5_000,
      ),
    };
  } catch {
    return null;
  }
}

export function runProductAtomicActivationProcess(input = {}, options = {}) {
  const timeoutMs = Math.max(
    60_000,
    Number(options.timeoutMs) || 30 * 60 * 1000,
  );
  return new Promise((resolve, reject) => {
    const child = fork(childPath, [], {
      env: {
        ...process.env,
        // The desktop local-api itself runs through Electron as Node. Its
        // child must retain the same mode instead of booting an Electron app.
        ELECTRON_RUN_AS_NODE: "1",
      },
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    let settled = false;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      const error = new Error("商品原子快照后台激活超时。");
      error.code = "PRODUCT_SYNC_ACTIVATION_PROCESS_TIMEOUT";
      reject(error);
    }, timeoutMs);
    timer.unref?.();

    const finish = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      callback();
      return true;
    };

    child.on("message", (message) => {
      if (message?.type === "started") {
        options.onStarted?.(message);
        return;
      }
      if (message?.type !== "result") return;
      finish(() => {
        child.disconnect?.();
        if (message.ok) {
          resolve(message.result);
          return;
        }
        const error = new Error(
          message?.error?.message || "商品原子快照后台激活失败。",
        );
        error.code =
          message?.error?.code || "PRODUCT_SYNC_ACTIVATION_PROCESS_FAILED";
        error.childStack = message?.error?.stack || "";
        error.childStderr = stderr;
        reject(error);
      });
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (settled) return;
      const settleExited = () => {
        if (settled) return;
        finish(() => {
          const error = new Error(`商品原子快照后台进程提前退出：${code}`);
          error.code = "PRODUCT_SYNC_ACTIVATION_PROCESS_EXITED";
          error.childStderr = stderr;
          reject(error);
        });
      };
      // Windows can report the process exit before Electron's IPC message is
      // dispatched to this listener. A short grace window lets the already
      // flushed result win without masking a genuine non-zero exit.
      if (code === 0) setTimeout(settleExited, 250);
      else settleExited();
    });
    child.send(input, (error) => {
      if (error) finish(() => reject(error));
    });
  });
}
