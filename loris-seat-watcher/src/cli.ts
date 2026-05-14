/**
 * CLI: load watches from subscriptions.json, run checks, email on interesting changes.
 *
 * npm run check
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckResult, WatchRequest } from "./types.js";
import { checkLoris } from "./lorisChecker.js";
import { sendMail, smtpFromEnv, smtpFromEnvOptional } from "./mail.js";

type Subscription = WatchRequest & { id: string };

type StateFile = Record<
  string,
  { fingerprint: string; lastNotified?: string }
>;

function fingerprintMatch(m: CheckResult["matched"][number]): string {
  const parts = [
    m.crn,
    m.section,
    m.enrolled ?? "",
    m.capacity ?? "",
    m.waitEnrolled ?? "",
    m.waitCapacity ?? "",
    m.seatsText,
  ];
  return parts.join("|");
}

function summarizeAvailability(m: CheckResult["matched"][number]): string {
  const lines: string[] = [];
  if (m.capacity != null && m.enrolled != null) {
    const open = m.enrolled < m.capacity;
    lines.push(`Seats: ${m.enrolled} of ${m.capacity} (${open ? "NOT FULL" : "FULL"})`);
  } else {
    lines.push(`Seats (raw): ${m.seatsText}`);
  }
  if (m.waitCapacity != null && m.waitEnrolled != null) {
    lines.push(`Waitlist: ${m.waitEnrolled} of ${m.waitCapacity}`);
  }
  return lines.join("\n");
}

function truthyEnv(v: string | undefined): boolean {
  return ["1", "true", "yes"].includes((v ?? "").toLowerCase());
}

function loadDotEnv() {
  // Minimal .env loader without extra dependency
  const envPath = path.resolve(process.cwd(), ".env");
  return readFile(envPath, "utf8")
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

  const skipEmail =
    truthyEnv(process.env.SKIP_EMAIL) || process.argv.includes("--dry-run");
  const smtp = skipEmail ? null : smtpFromEnvOptional();
  if (!skipEmail && !smtp) {
    smtpFromEnv();
  }

  const storage = process.env.LORIS_STORAGE_STATE ?? "./storageState.json";
  const subsPath = path.resolve(process.cwd(), "subscriptions.json");
  const statePath = path.resolve(process.cwd(), ".cache", "state.json");

  const argv = process.argv.slice(2);
  const headed =
    argv.includes("--headed") ||
    truthyEnv(process.env.LORIS_HEADED) ||
    process.env.LORIS_HEADLESS === "0" ||
    process.env.LORIS_HEADLESS === "false";
  const debug = argv.includes("--debug") || truthyEnv(process.env.LORIS_DEBUG);

  const headless = !headed;

  const raw = await readFile(subsPath, "utf8");
  const subs = JSON.parse(raw) as Subscription[];
  if (!Array.isArray(subs) || subs.length === 0) {
    throw new Error("subscriptions.json must be a non-empty array");
  }

  await mkdir(path.dirname(statePath), { recursive: true }).catch(() => {});

  let state: StateFile = {};
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
  } catch {
    state = {};
  }

  const operator = process.env.OPERATOR_EMAIL;

  for (const sub of subs) {
    const result = await checkLoris(storage, sub, { headless, debug });
    const key = sub.id;

    if (result.error === "STORAGE_STATE_MISSING") {
      const msg =
        `Missing storage state file: ${path.resolve(process.cwd(), storage)}\n` +
        "Run `npm run save-session` from this project folder (so storageState.json is created here), " +
        "or set LORIS_STORAGE_STATE to the full path of your saved JSON.";
      console.error(msg);
      continue;
    }

    if (result.error === "SESSION_OR_LOGIN") {
      const msg =
        "LORIS reported a real login / SSO page, a visible password box, or a session-expired banner.\n" +
        (result.detail ? `${result.detail}\n` : "") +
        "Try: `npm run save-session` again (complete login → Register for Classes → term → Find Classes, then Enter).\n" +
        "If you believe you are logged in, run with a visible browser: `npm run check -- --headed --dry-run`\n" +
        `Watch: ${sub.id} (${sub.termLabel} ${sub.subject} ${sub.courseNumber}${sub.crn ? ` CRN ${sub.crn}` : ""})`;
      if (operator && smtp) {
        await sendMail({
          smtp,
          to: operator,
          subject: "[LORIS watcher] Session expired",
          text: msg,
        });
      }
      console.error(msg);
      continue;
    }

    if (result.error === "FLOW_FAILED") {
      console.error(
        `FLOW_FAILED for ${sub.id}: ${result.detail ?? "(no detail)"}\n` +
          "Tip: many school portals block headless Chrome. Run:\n" +
          "  npm run check -- --headed --debug --dry-run\n" +
          "That opens a real window and saves .cache/loris-debug.png on failure.",
      );
      continue;
    }

    if (result.matched.length === 0) {
      console.warn(`No rows matched for ${sub.id}. Check subject/course/term/CRN filters.`);
      continue;
    }

    const fp = result.matched.map(fingerprintMatch).sort().join("||");
    const prev = state[key]?.fingerprint;
    state[key] = { ...state[key], fingerprint: fp };

    const isFirstRun = prev === undefined;
    const changed = !isFirstRun && prev !== fp;

    // Notify when seats open up (enrolled < capacity) or waitlist has space
    const interesting = result.matched.filter((m) => {
      const seatOpen = m.capacity != null && m.enrolled != null && m.enrolled < m.capacity;
      const waitOpen =
        m.waitCapacity != null && m.waitEnrolled != null && m.waitEnrolled < m.waitCapacity;
      return seatOpen || waitOpen;
    });

    const bodySections = result.matched.map((m) => {
      return [
        `---`,
        `CRN: ${m.crn}`,
        `${m.subject} ${m.courseNumber} sec ${m.section}`,
        m.title ? `Title: ${m.title}` : "",
        summarizeAvailability(m),
      ]
        .filter(Boolean)
        .join("\n");
    });

    const shouldNotifyStudent =
      interesting.length > 0 && (isFirstRun ? interesting.length > 0 : changed);

    if (shouldNotifyStudent) {
      const text =
        `Automated check for ${sub.subject} ${sub.courseNumber} (${sub.termLabel}).\n\n` +
        bodySections.join("\n\n") +
        `\n\nIf you no longer want emails, remove this entry from subscriptions.json.`;
      if (smtp) {
        await sendMail({
          smtp,
          to: sub.notifyEmail,
          subject: `[LORIS] Update: ${sub.subject} ${sub.courseNumber} (${sub.termLabel})`,
          text,
        });
        state[key].lastNotified = new Date().toISOString();
      } else {
        console.log(
          `[SKIP_EMAIL] Would notify ${sub.notifyEmail}:\n${text}\n`,
        );
      }
    }

    console.log(
      `OK ${sub.id}: matched ${result.matched.length} row(s); interesting=${interesting.length}; notified=${shouldNotifyStudent}`,
    );
  }

  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
