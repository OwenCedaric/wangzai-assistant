import { Worker } from 'node:worker_threads';

const workerUrl = new URL('./imageProvenanceWorker.js', import.meta.url);

export function runImageProvenanceWorker(input = {}, options = {}) {
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || 120_000);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: input });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      const error = new Error('PSD、PDF 和暗水印后台处理超时。');
      error.code = 'IMAGE_PROVENANCE_WORKER_TIMEOUT';
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
    worker.once('message', (message) => finish(() => {
      void worker.terminate();
      if (message?.ok) resolve(message.result);
      else {
        const error = new Error(message?.error?.message || 'PSD、PDF 和暗水印后台处理失败。');
        error.code = message?.error?.code || 'IMAGE_PROVENANCE_WORKER_FAILED';
        error.workerStack = message?.error?.stack || '';
        reject(error);
      }
    }));
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(() => {
        const error = new Error(`PSD、PDF 和暗水印后台进程异常退出：${code}`);
        error.code = 'IMAGE_PROVENANCE_WORKER_EXITED';
        reject(error);
      });
    });
  });
}
