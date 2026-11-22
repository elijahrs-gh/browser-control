# browser-control
A fast browser-control engine for giving AI agents access to Chromium-based browsers.

It was originally designed for OpenClaw, but it does work with other agents/models. It lets an agent shop or visit websites in your own Chromium-based
browser, and answer with real, re-verified links.

Ask your agent:

> Find five Christmas gifts from Etsy and give me the links.

The agent opens the store's search page in Helium ( or your browser of choice ), reads it as compact
structured data (never whole-page HTML), picks five products, reopens every
product page live to confirm the product, price and link, and replies with
the verified list.

## How it works

```
OpenClaw agent ──exec──> tools/shop.mjs ──> openclaw browser --browser-profile chrome --json …
                                                 │  (official tabs, labels, navigation policy)
                                                 ▼
                                  Gateway browser control ──> extension relay
                                                 ▼
                       Helium + "OpenClaw Helium Shopper" extension (chrome.debugger)
```

- **`extension/`** is OpenClaw's own browser-relay extension
  (`extensions/browser/chrome-extension` in the OpenClaw repo), renamed for
  Helium. It uses OpenClaw's pairing, tab-access controls and origin-locked
  native bootstrap unchanged.
- **`tools/shop.mjs`** is the CLI the agent calls. Every browser step goes
  through the official `openclaw browser` command (open, navigate, evaluate),
  so OpenClaw keeps ownership of tabs, labels and its URL safety policy.
- **`shopper/reader.js`** is a fixed, read-only page reader. It turns a
  search or product page into product cards (title, price, rating, sponsored
  flag, canonical link) plus JSON-LD facts, filters ads, nav, footer and
  duplicates, strips tracking parameters, and detects captcha and login
  walls. The model never supplies page code.
- **`skill/helium-shopper/SKILL.md`** teaches the agent a two-call flow,
  `search` then `pick`, and triggers automatically on shopping requests.

No new relay, protocol or Gateway plugin is involved, and no OpenClaw config
change is needed.

## Requirements

- macOS. Tested with Helium 0.21 on a 16 GB Mac ( it's preferred to have more then 8 GB due to how much RAM browser automations can use )
- Node.js 22 or newer.
- An OpenClaw **source checkout**, built, with its Gateway running. The
  installer uses OpenClaw's own native-host installer modules from the
  checkout. Default location: `~/Developer/openclaw`. Set `OPENCLAW_ROOT` if
  yours is elsewhere.
- A model configured in OpenClaw. It was developed with Kimi K3.1 Pro on
  Cerebras, but any tool-calling model works.

## Setup

### 1. Get the code

```sh
git clone <this repo> helium-shopper
cd helium-shopper
npm install          # only needed for `npm test`
```

### 2. Install the extension copy and the native host

Inspect first, then apply:

```sh
npm run install:helium              # inspect only, writes nothing
npm run install:helium -- --apply   # writes
```

`--apply` does two things:

- It copies `extension/` to `~/.openclaw/browser/helium-shopper-extension/`.
- It registers OpenClaw's native bootstrap host in Helium's data directory, at
  `~/Library/Application Support/net.imput.helium/NativeMessagingHosts/ai.openclaw.browser_bootstrap.json`.

The host is **origin-locked** to the extension ID of that exact copy. The
command prints the ID, so note it down.

It never edits `openclaw.json` or restarts the Gateway. It refuses to
overwrite a native-host registration or extension copy that it didn't create.

### 3. Load the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose
   `~/.openclaw/browser/helium-shopper-extension`. Load the installed copy,
   **not** this repo's `extension/` folder.
3. Check that the extension ID matches the one the installer printed.
4. Open the extension's **Options** page, choose **Use local OpenClaw**, and
   pick which tabs OpenClaw may control.

### 4. Check the connection

```sh
node "$OPENCLAW_ROOT/openclaw.mjs" browser --browser-profile chrome status
```

You should see `"running": true`. The default `chrome` profile already uses
the extension driver, so it drives whichever browser has the extension
loaded.

Then run a live search yourself:

```sh
npm run shop -- search --site etsy --query "christmas gifts"
```

### 5. Give the agent the skill

```sh
npm run install:skill
```

This writes `~/.openclaw/workspace/skills/helium-shopper/SKILL.md` with the
absolute path to this checkout's `tools/shop.mjs` filled in. Set
`OPENCLAW_WORKSPACE` to install into a different workspace.

Start a new chat session and confirm the skill is listed:

```sh
node "$OPENCLAW_ROOT/openclaw.mjs" skills list
```

### 6. Try it

In the OpenClaw web chat, send:

> Find five Christmas gifts from Etsy and give me the links.

The skill supports `etsy`, `amazon`, `walmart`, `target` and `bestbuy`. Etsy
is the most reliable. The others often show captchas to automated browsers,
and the skill then tells you the site blocked it instead of guessing.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENCLAW_ROOT` | `~/Developer/openclaw` | OpenClaw source checkout |
| `OPENCLAW_STATE_DIR` | `~/.openclaw` | OpenClaw state (extension copy, workspace) |
| `OPENCLAW_WORKSPACE` | `$OPENCLAW_STATE_DIR/workspace` | Where `install:skill` writes the skill |
| `HELIUM_USER_DATA_DIR` | `~/Library/Application Support/net.imput.helium` | Browser data directory for the native host. Point it at another Chromium browser's directory to use that browser instead |
| `SHOP_BROWSER_PROFILE` | `chrome` | OpenClaw browser profile to drive |
| `SHOP_RUNS_DIR` | `./runs` | Where run artifacts are written |
| `READER_TEST_BROWSER` | Helium binary | Chromium binary for `npm test` |

## Commands

```
npm run shop -- <command>

search  [--site etsy] [--query <q>]           New run: open one store search, list candidates c1..cN
pick    --run <id> --ids c1,c4,...            Verify picks in parallel tabs; prints the final list
start   --query <q> [--purpose demo|test]     Create a run directory
tabs                                          List tabs (slow with "All tabs" access)
bench   --run <id> [--rounds 1-3] [--retailers amazon,etsy,...]
                                              Rank stores by browser-measured load time
read    --run <id> --tab <handle> [--markdown]
open    --run <id> --url <url> --label <shop-...>
stage   [--site etsy]                         Demo layout: chat window left, store window right (AppleScript)
verify  --run <id> --url <product url> --title <observed title>
report  --run <id>                            Final list of verified gifts
tps     --run <id> --output-tokens N --first-ms A --last-ms B --source <source>
                                              Record real token telemetry: (tokens − 1) / (last − first)
```

`verify` and `pick` only accept product URLs that were actually seen on a
live page in the same run. A product counts as verified only when the
reopened page matches the retailer, product ID and title, and shows a price.

## Run artifacts

Each run writes `runs/<UTC stamp>-<hex>/`:

| File | Contents |
|---|---|
| `run.json` | query, purpose, start time, browser profile |
| `candidates.jsonl` | every product card observed, with source page and time |
| `reads.jsonl` | each page read |
| `gifts.jsonl` | each verification: status, reasons, verified URL, price, availability |
| `bench-samples.jsonl`, `benchmarks.json` | store benchmark samples and ranking |
| `performance.json` | real token telemetry from `tps` |
| `report.json` | final summary |

## Safety

- The extension uses OpenClaw's tab-access controls. Choose **Selected
  tabs** if you don't want your personal tabs visible to OpenClaw. You can
  pause or revoke access from the extension popup at any time.
- The tools only read pages and navigate. They never add to cart, sign in,
  or buy anything.
- Page text is treated as untrusted data, never as instructions.
- `tests/fixtures/` are test-only pages and are never used as results.

## Troubleshooting

- **Options page stuck on "Looking for local OpenClaw…"**: Helium loaded a
  copy whose extension ID doesn't match the native host. Remove the
  extension, then load `~/.openclaw/browser/helium-shopper-extension`. An
  unpacked extension's ID is derived from its folder path.
- **`status` shows `running: false`**: start the OpenClaw Gateway and check
  that the extension popup shows it's connected.
- **Machine slows down or crashes**: each browser step starts an OpenClaw CLI
  process, and `pick` verifies five products in parallel. Close unneeded
  Helium tabs, especially on 16 GB machines.
- **`tabs` is slow**: with "All tabs" access every tab is listed. The other
  commands use labeled tabs and never list them.
- **Captcha or `blocked` results**: the store showed a bot check. Try Etsy, or
  solve the check in the tab and run the search again.

## Tests

```sh
npm test
```

These are unit tests for ranking, verification and the TPS formula, plus the
page reader against the fixture pages. The reader test runs in a throwaway
headless Helium profile with all network intercepted. It's skipped if no
browser binary is found.

## Uninstall

1. Remove the extension in Helium.
2. Delete `~/.openclaw/browser/helium-shopper-extension/`.
3. Delete
   `~/Library/Application Support/net.imput.helium/NativeMessagingHosts/ai.openclaw.browser_bootstrap.json`.
4. Delete `~/.openclaw/workspace/skills/helium-shopper/`.

## License

MIT, see `LICENSE`. The browser extension in `extension/` is derived from
OpenClaw's browser extension, © 2026 OpenClaw Foundation, MIT. Its license
is in `extension/LICENSE-OPENCLAW`.
