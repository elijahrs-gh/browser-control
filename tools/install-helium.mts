// Helium native-bootstrap setup using OpenClaw's own installer modules.
//
//   node --import ~/Developer/openclaw/scripts/tsx.mjs tools/install-helium.mts          # inspect only
//   node --import ~/Developer/openclaw/scripts/tsx.mjs tools/install-helium.mts --apply  # write
//
// --apply copies the reviewed unpacked extension (tests excluded) to
// ~/.openclaw/browser/helium-shopper-extension and registers the OpenClaw
// native host in Helium's own NativeMessagingHosts directory, origin-locked to
// that exact copy's extension ID. It never edits openclaw.json, never restarts
// the Gateway, and refuses foreign or invalid existing registrations.
import fs from "node:fs/promises";
import path from "node:path";

const OPENCLAW_ROOT = path.resolve(process.env.OPENCLAW_ROOT || path.join(process.env.HOME!, "Developer", "openclaw"));
const browserSrc = path.join(OPENCLAW_ROOT, "extensions", "browser", "src", "browser");
const { inspectRegistration, installRegistration } = await import(path.join(browserSrc, "extension-install-registration.ts"));
const { assertOwnedPath, ensurePrivateDirectory, generateChromeExtensionIdForPath } = await import(path.join(browserSrc, "extension-install-layout.ts"));

const apply = process.argv.includes("--apply");
const browserProfile = process.env.SHOP_BROWSER_PROFILE || "chrome";
const source = await fs.realpath(path.join(import.meta.dirname, "..", "extension"));
const stateDir = path.resolve(process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME!, ".openclaw"));
const target = path.join(stateDir, "browser", "helium-shopper-extension");
const markerName = ".openclaw-owned.json";
// Helium's real bundle-specific data directory (not ~/Library/Application Support/Helium).
const userDataDir = path.resolve(process.env.HELIUM_USER_DATA_DIR || path.join(process.env.HOME!, "Library", "Application Support", "net.imput.helium"));
const root = { product: "chromium", label: "Helium", userDataDir, nativeManifestDir: path.join(userDataDir, "NativeMessagingHosts") };

const excluded = (name: string) => /\.test\.[jt]s$|\.test-support\.ts$|\.test-harness\.ts$|\.d\.ts$/.test(name);

async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const src = path.join(from, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in extension source: ${src}`);
    if (entry.isDirectory()) await copyTree(src, path.join(to, entry.name));
    else if (entry.isFile()) await fs.copyFile(src, path.join(to, entry.name), fs.constants.COPYFILE_EXCL);
  }
}

async function ownedCopy(): Promise<boolean | null> {
  if (!(await fs.lstat(target).catch(() => null))) return null;
  const marker = JSON.parse(await fs.readFile(path.join(target, markerName), "utf8").catch(() => "{}"));
  return marker.source === source;
}

if (!(await fs.stat(path.join(userDataDir, "Local State")).catch(() => null))) {
  throw new Error(`Helium user data not found at ${userDataDir}. Set HELIUM_USER_DATA_DIR.`);
}
const owned = await ownedCopy();
if (owned === false) throw new Error(`Refusing to replace ${target}: it is not owned by this installer.`);

if (apply) {
  await ensurePrivateDirectory(path.dirname(target));
  if (owned) {
    await assertOwnedPath(target, "directory");
    await fs.rm(target, { recursive: true });
  }
  await copyTree(source, target);
  await fs.writeFile(path.join(target, markerName), `${JSON.stringify({ v: 1, source })}\n`, { mode: 0o600 });
  await fs.chmod(target, 0o700);
}

const extensionPath = (await fs.stat(target).catch(() => null)) ? await fs.realpath(target) : path.resolve(target);
const extensionId = generateChromeExtensionIdForPath(extensionPath);
const before = await inspectRegistration(root, [extensionId]);
let registration = before;
if (apply) {
  registration = await installRegistration({
    root,
    extensionIds: [extensionId],
    pluginRoot: path.join(OPENCLAW_ROOT, "dist", "extensions", "browser"),
    browserProfile,
  });
}

console.log(JSON.stringify({
  mode: apply ? "applied" : "inspect-only (pass --apply to write)",
  browser: "Helium",
  userDataDir,
  extensionPath,
  extensionId,
  allowedOrigin: `chrome-extension://${extensionId}/`,
  browserProfile,
  nativeHost: { manifestPath: registration.manifestPath, state: registration.state, issue: registration.issue ?? null },
  nextSteps: [
    "In Helium open helium://extensions (or chrome://extensions), enable Developer mode.",
    `Load unpacked -> ${extensionPath}`,
    `Confirm the loaded extension ID is ${extensionId}; any other ID will be refused by the native host.`,
    "Open the extension's options and choose Use local OpenClaw; allow only the tabs you want controlled.",
    `Check: node ${path.join(OPENCLAW_ROOT, "openclaw.mjs")} browser --browser-profile ${browserProfile} status`,
  ],
}, null, 2));
