#!/usr/bin/env node
// Installs the helium-shopper skill into the OpenClaw agent workspace, with the
// absolute path to this checkout's tools/shop.mjs filled in.
//
//   node tools/install-skill.mjs            # writes ~/.openclaw/workspace/skills/helium-shopper/SKILL.md
//   OPENCLAW_WORKSPACE=/path node tools/install-skill.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cli = path.resolve(import.meta.dirname, "shop.mjs");
const workspace = path.resolve(process.env.OPENCLAW_WORKSPACE || path.join(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"), "workspace"));
const template = await fs.readFile(path.join(import.meta.dirname, "..", "skill", "helium-shopper", "SKILL.md"), "utf8");
const target = path.join(workspace, "skills", "helium-shopper", "SKILL.md");

await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, template.replaceAll("{{SHOP_CLI}}", JSON.stringify(cli)));
console.log(JSON.stringify({ installed: target, shopCli: cli, next: "Start a new chat session (or restart the Gateway) so the agent picks up the skill." }, null, 2));
