// Thin client over the official `openclaw browser` CLI. Tabs, labels, exact
// target binding, navigation policy and the extension relay stay owned by
// OpenClaw; this module only invokes documented commands and parses --json.
import { execFile } from "node:child_process";
import path from "node:path";
import { readerFunctionSource } from "./reader.js";

const OPENCLAW_ROOT = path.resolve(process.env.OPENCLAW_ROOT || path.join(process.env.HOME, "Developer", "openclaw"));
export const BROWSER_PROFILE = process.env.SHOP_BROWSER_PROFILE || "chrome";

export class BrowserCliError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

function parseJson(stdout) {
  const start = stdout.search(/[{[]/);
  if (start < 0) throw new BrowserCliError("openclaw browser returned no JSON", { stdout: stdout.slice(0, 400) });
  return JSON.parse(stdout.slice(start));
}

export function browserCli(args, { timeoutMs = 60000 } = {}) {
  const argv = [path.join(OPENCLAW_ROOT, "openclaw.mjs"), "browser", "--browser-profile", BROWSER_PROFILE, "--json", "--timeout", String(Math.max(30000, timeoutMs - 5000)), ...args];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, argv, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message).trim().split("\n").slice(-3).join(" ").slice(0, 500);
        reject(new BrowserCliError(`openclaw browser ${args[0]} failed: ${message}`, { code: error.code }));
        return;
      }
      try { resolve(parseJson(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
}

export async function listTabs() {
  const result = await browserCli(["tabs"]);
  return Array.isArray(result.tabs) ? result.tabs : [];
}

/** The handle OpenClaw tells agents to pass back unchanged. */
export function tabHandle(tab) {
  return tab.suggestedTargetId ?? tab.label ?? tab.tabId ?? tab.targetId;
}

/** Open (or reuse by exact label) a labeled tab through the official route. */
export async function openLabeledTab(url, label) {
  // Resolve by label directly: listing every tab is slow when the extension
  // has "All tabs" access, and the label is itself an official tab reference.
  try {
    const navigated = await browserCli(["navigate", url, "--target-id", label]);
    return { ...navigated, label, handle: label, reused: true };
  } catch (error) {
    if (!/tab not found/i.test(String(error.message))) throw error;
  }
  const opened = await browserCli(["open", url, "--label", label]);
  return { ...opened, handle: tabHandle(opened), reused: false };
}

/** Run the fixed shopping reader in the exact tab. Agents never supply page code here. */
export async function readTab(handle, options = {}) {
  // The reader waits in-page, so no separate `wait` call is needed. A read
  // that races the navigation commit (old/blank document) is retried.
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await browserCli(
        ["evaluate", "--target-id", handle, "--timeout-ms", "15000", "--fn", readerFunctionSource(options)],
        { timeoutMs: 45000 },
      );
      const result = response && typeof response === "object" && "result" in response ? response.result : response;
      if (!result || typeof result !== "object" || result.v !== 1) {
        throw new BrowserCliError("Shopping reader returned an unexpected result", { keys: Object.keys(response ?? {}) });
      }
      if (!/^https?:/.test(result.url) && attempt < 2) continue;
      return { ...result, tab: handle };
    } catch (error) {
      if (attempt >= 2 || !/context was destroyed|navigat|detached|not found/i.test(String(error.message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}
