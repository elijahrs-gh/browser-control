// Run artifacts. Schema is documented in README.md ("Run artifact schema").
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const RUNS_ROOT = path.resolve(process.env.SHOP_RUNS_DIR || path.join(import.meta.dirname, "..", "runs"));
export const SCHEMA_VERSION = 1;

export async function createRun({ query, purpose }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const dir = path.join(RUNS_ROOT, `${stamp}-${crypto.randomBytes(3).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const run = { schema: SCHEMA_VERSION, id: path.basename(dir), query, purpose, startedAt: new Date().toISOString(), browserProfile: process.env.SHOP_BROWSER_PROFILE || "chrome" };
  await fs.writeFile(path.join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return dir;
}

export async function resolveRun(value) {
  const dir = path.resolve(value?.includes(path.sep) ? value : path.join(RUNS_ROOT, value ?? ""));
  if (!value || !(await fs.stat(path.join(dir, "run.json")).catch(() => null))) {
    throw new Error(`Unknown run: ${value ?? "(none)"}. Start one with: shop.mjs start --query "..."`);
  }
  return dir;
}

export async function appendJsonl(dir, name, record) {
  await fs.appendFile(path.join(dir, name), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
}

export async function readJsonl(dir, name) {
  const text = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function writeJson(dir, name, value) {
  await fs.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function readJson(dir, name) {
  return JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
}
