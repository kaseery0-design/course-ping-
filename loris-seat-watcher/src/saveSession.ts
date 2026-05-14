/**
 * One-time (or occasional) interactive login saver.
 *
 * Usage:
 *   set LORIS_STORAGE_STATE=./storageState.json
 *   npm run save-session
 *
 * A browser opens; complete Laurier login + MFA if prompted.
 * Best: navigate until you see **Register for Classes** → **term** → **Find Classes** (proves cookies for registration).
 * Then press Enter here to save.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  await readFile(envPath, "utf8")
    .then((raw) => {
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!process.env[k]) process.env[k] = v;
      }
    })
    .catch(() => {});
}

async function main() {
  await loadDotEnv();

  const rawOut = process.env.LORIS_STORAGE_STATE ?? "./storageState.json";
  const outPath = path.resolve(process.cwd(), rawOut);
  const startUrl =
    process.env.LORIS_START_URL ?? "https://loris.wlu.ca/register/ssb/registration";

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });

  const rl = readline.createInterface({ input, output });
  await rl.question(
    "In the browser: log in (MFA if needed), open **Register for Classes**, pick a term, until you see **Find Classes** / course search. " +
      "Then return here and press Enter to save cookies...\n> ",
  );
  rl.close();

  await context.storageState({ path: outPath });
  await browser.close();
  console.log(`Saved storage state to:\n  ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
