// Demo layout for recording: OpenClaw chat window on the left half, the
// retailer window on the right half. Uses Helium's AppleScript dictionary for
// window placement only; the retailer tab itself is opened and labeled through
// the official `openclaw browser open` route, so the shopping tools reuse it.
import { execFile } from "node:child_process";
import { browserCli } from "./browser.mjs";

const CHAT_URL = process.env.SHOP_CHAT_URL || "http://127.0.0.1:18789/";
const MENU_BAR = 38;

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 20000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`osascript: ${(stderr || error.message).trim().slice(0, 300)}`));
      else resolve(stdout.trim());
    });
  });
}

const quote = (value) => `"${String(value).replace(/[\\"]/g, "\\$&")}"`;

export async function stageDemoWindows({ retailerUrl, label, giftLabels = [] }) {
  const status = await browserCli(["status"]);
  if (status.running !== true) {
    throw new Error("Helium is not connected to OpenClaw. Start the Gateway and check the extension, then retry.");
  }
  const [x0, y0, x1, y1] = (await osascript('tell application "Finder" to get bounds of window of desktop')).split(/,\s*/).map(Number);
  const top = y0 + MENU_BAR;
  const mid = Math.round((x0 + x1) / 2);
  const left = `{${x0}, ${top}, ${mid}, ${y1}}`;
  const right = `{${mid}, ${top}, ${x1}, ${y1}}`;

  // A previous run's labeled tabs may sit in some other window; start clean.
  await Promise.all([label, ...giftLabels].map((name) => browserCli(["close", name]).catch(() => {})));

  // Right: a fresh window. The extension creates tabs in the last focused
  // window, so the labeled retailer tab lands here.
  await osascript(`tell application "Helium"
  activate
  set w to make new window
  set bounds of w to ${right}
end tell`);
  // Gift-slot tabs first (pick navigates them in parallel), search tab last so it is the active one.
  for (const name of giftLabels) await browserCli(["open", retailerUrl, "--label", name]);
  await browserCli(["open", retailerUrl, "--label", label]);
  const origin = new URL(retailerUrl).origin;
  const landed = await osascript(`tell application "Helium"
  set w to window 1
  set extra to (every tab of w whose URL does not start with ${quote(origin)})
  if (count of tabs of w) > (count of extra) then
    repeat with t in extra
      close t
    end repeat
  end if
  return (count of (every tab of w whose URL starts with ${quote(origin)}))
end tell`);

  // Left: the OpenClaw chat, focused last so you can type straight away.
  await osascript(`tell application "Helium"
  set c to make new window
  set URL of active tab of c to ${quote(CHAT_URL)}
  set bounds of c to ${left}
  activate
end tell`);

  return {
    ok: Number(landed) > giftLabels.length,
    layout: { chat: left, retailer: right },
    retailerTab: label,
    giftTabs: giftLabels,
    retailerTabsInRightWindow: Number(landed),
    ...(Number(landed) > giftLabels.length ? {} : { warning: "Not every retailer tab landed in the right-hand window; drag the missing ones there before recording." }),
    next: "Start a new chat session in the left window and send your prompt.",
  };
}
