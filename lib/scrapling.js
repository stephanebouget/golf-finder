import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(
  new URL("../scrapling_worker.py", import.meta.url),
);

export function fetchWithScrapling(
  url,
  { headers, mode = "http", timeoutMs, signal },
) {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ??
        new DOMException("The operation was aborted", "AbortError"),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.SCRAPLING_PYTHON ??
        (process.platform === "win32" ? "py" : "python3"),
      [WORKER_PATH],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => {
      child.kill();
      finish(
        reject,
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(`Scrapling timed out after ${timeoutMs} ms`);
      error.name = "TimeoutError";
      finish(reject, error);
    }, timeoutMs);

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          reject,
          new Error(stderr.trim() || `Scrapling worker exited with code ${code}`),
        );
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          finish(reject, new Error(`${result.errorType}: ${result.error}`));
          return;
        }
        finish(resolve, result);
      } catch (error) {
        finish(
          reject,
          new Error(
            `Invalid response from Scrapling worker: ${error.message}; ${stderr.trim()}`,
          ),
        );
      }
    });

    child.stdin.end(JSON.stringify({ url, headers, mode, timeoutMs }));
  });
}
