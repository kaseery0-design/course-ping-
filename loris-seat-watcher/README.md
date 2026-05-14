# Laurier LORIS seat watcher (Playwright)

Automates the flow you described on **Wilfrid Laurier LORIS**:

1. Open `https://loris.wlu.ca/register/ssb/registration`
2. Click **Register for Classes**
3. Choose **term** (must match the label in the dropdown, e.g. `Spring 2026`)
4. **Find Classes** → enter **Subject** + **Course Number** → **Search**
5. Parse **Class Seats** / waitlist text and optional **CRN** match
6. Email the student when seats or waitlist capacity indicate availability

## Important

- **Terms of service / automation**: only use this in ways permitted by Laurier and your accounts. This tool is a template; you are responsible for compliance.
- **Sessions expire**: Laurier login typically lasts a few days. When it breaks, re-run `npm run save-session` and consider emailing yourself via `OPERATOR_EMAIL`.
- **Selectors**: Banner/SSB pages change. If something breaks, run `npx playwright codegen https://loris.wlu.ca/register/ssb/registration` and update `src/lorisChecker.ts`.
- **“Multiple sessions” / concurrent login**: Laurier sometimes only allows one active registration session per account. If you see that message while testing, it is **from the server**, not a bug in this repo. Close other LORIS tabs and browsers (including on your phone), wait a few minutes, then try again—often it clears on its own, as you have seen. Avoid running the checker on two machines at the same time with the same saved session.

## Setup

```bash
cd loris-seat-watcher
npm install
npx playwright install chromium
copy .env.example .env
copy subscriptions.example.json subscriptions.json
```

Edit `subscriptions.json` (real student emails + course info). Edit `.env` with SMTP.

### Save your logged-in session (recommended)

```bash
npm run save-session
```

Complete MFA in the opened browser, then click **Register for Classes** and go at least as far as the **term** + **Find Classes** screen (so cookies cover the registration app). Press Enter in the terminal to save. Output shows the **absolute path** to `storageState.json` (or `LORIS_STORAGE_STATE`).

Run `check` from the **same folder** so that path is found, or set `LORIS_STORAGE_STATE` to that full path in `.env`.

**Note:** The normal LORIS hub shows **Guest Sign In**; an older version of this tool treated that as “logged out”. Session detection now only flags real SSO/login pages or explicit “session expired” messages.

### Run a check

```bash
npm run check
```

**If you see “SMTP is not configured”:** either fill in `SMTP_HOST`, `SMTP_USER`, etc. in `.env`, **or** test without email:

```bash
npm run check -- --dry-run
```

(PowerShell alternative: `$env:SKIP_EMAIL = "1"; npm run check`.)

**If checks fail mysteriously** (timeouts, wrong “session”, no rows): many school portals misbehave in **headless** Chrome. Run once with a real browser window and a debug screenshot:

```bash
npm run check -- --headed --debug --dry-run
```

On failure this writes `.cache/loris-debug.png` and prints the current URL and page title. You can set `LORIS_HEADLESS=0` in `.env` instead of `--headed`.

Schedule with **Task Scheduler** (Windows) or **cron** (Linux) every N minutes.

## How matching works

- **Subject** + **Course Number** are filled into the Find Classes form.
- If **`crn`** is non-empty in `subscriptions.json`, only that CRN row is kept.
- If **`crn`** is empty, rows are heuristically matched on subject/course columns.

## Email behavior

- On **first successful run**, students receive an email if any matched row shows **seat availability** (`enrolled < capacity`) or **waitlist room** (`waitEnrolled < waitCapacity`).
- On later runs, students are emailed when the **fingerprint** of matched rows changes (typically seat/waitlist counts changed). Tune logic in `src/cli.ts` if you want “only when it flips to open”.

## Files

- `src/lorisChecker.ts` — Playwright navigation + table scrape
- `src/cli.ts` — reads `subscriptions.json`, compares `.cache/state.json`, sends mail
- `src/saveSession.ts` — interactive cookie capture
- `src/mail.ts` — SMTP via Nodemailer
