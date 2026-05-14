import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import type { CheckResult, SeatSummary, WatchRequest } from "./types.js";

const REGISTRATION_URL = "https://loris.wlu.ca/register/ssb/registration";

function parseSeatsCell(text: string): Pick<
  SeatSummary,
  "enrolled" | "capacity" | "waitEnrolled" | "waitCapacity"
> {
  const out: Pick<
    SeatSummary,
    "enrolled" | "capacity" | "waitEnrolled" | "waitCapacity"
  > = {};
  const norm = text.replace(/\s+/g, " ").trim();

  // Examples from UI: "49 of 75 seats", "8 of 8 waitlist"
  const seatM = norm.match(/(\d+)\s+of\s+(\d+)\s+seat/i);
  if (seatM) {
    out.enrolled = Number(seatM[1]);
    out.capacity = Number(seatM[2]);
  }
  const waitM = norm.match(/(\d+)\s+of\s+(\d+)\s+wait/i);
  if (waitM) {
    out.waitEnrolled = Number(waitM[1]);
    out.waitCapacity = Number(waitM[2]);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function gotoRegistration(page: Page) {
  await page.goto(REGISTRATION_URL, { waitUntil: "domcontentloaded" });
}

async function clickRegisterForClasses(page: Page) {
  const link = page.getByRole("link", { name: /Register for Classes/i }).first();
  await link.waitFor({ state: "visible", timeout: 30_000 });
  await link.click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800);
}

/** True if we are already on class search (term already chosen in-session). */
async function termStepAlreadyComplete(page: Page): Promise<boolean> {
  if (await page.getByText("Enter Your Search Criteria", { exact: false }).first().isVisible().catch(() => false)) {
    return true;
  }
  if (await page.getByRole("tab", { name: /Find Classes/i }).first().isVisible().catch(() => false)) {
    return true;
  }
  if ((await firstVisible(page, "#txt_subject")) != null) return true;
  if (await page.getByText(/Term\s*:\s*/i).first().isVisible().catch(() => false)) return true;
  return false;
}

/**
 * Banner often renders Continue as `<input type="submit" value="Continue">`, which is not
 * always matched by `getByRole("button")`. The term Select2 overlay can also sit on top of
 * Continue until it is dismissed.
 */
async function clickContinueAfterTerm(page: Page) {
  const candidates: Locator[] = [
    page.getByRole("button", { name: /^Continue$/i }),
    page.getByRole("button", { name: /Continue/i }),
    page.locator(
      'input[type="submit"][value*="Continue"], input[type="submit"][value*="continue"], input[type="submit"][value*="CONTINUE"]',
    ),
    page.locator(
      'input[type="button"][value*="Continue"], input[type="button"][value*="continue"], input[type="button"][value*="CONTINUE"]',
    ),
    page.locator("button.submit").filter({ hasText: /^Continue$/i }),
    page.getByText(/^Continue$/i).first(),
  ];

  const tryOnce = async (): Promise<boolean> => {
    for (const loc of candidates) {
      const el = loc.first();
      if (await el.isVisible().catch(() => false)) {
        if (await el.isEnabled().catch(() => false)) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 12_000 });
          return true;
        }
      }
    }
    return false;
  };

  await page.locator(".select2-drop-active").waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  await page.locator("#select2-drop").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});

  const deadline = Date.now() + 25_000;
  let dismissedOverlay = false;
  while (Date.now() < deadline) {
    if (await tryOnce()) return;

    if (!dismissedOverlay) {
      await page.keyboard.press("Escape").catch(() => {});
      dismissedOverlay = true;
      await page.waitForTimeout(350);
      await page.locator(".select2-drop-active").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      continue;
    }

    await page.locator(".select2-drop-active").waitFor({ state: "hidden", timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(250);
  }

  throw new Error(
    "CONTINUE_BUTTON_NOT_FOUND after term selection. UI may label the control differently than Continue.",
  );
}

async function selectNativeTermSelect(page: Page, termLabel: string): Promise<boolean> {
  const sel = page.locator("select#term_id, select[name='term'], select[id*='term']").first();
  if (!(await sel.isVisible().catch(() => false))) return false;

  try {
    await sel.selectOption({ label: termLabel });
  } catch {
    const labels = await sel.locator("option").allInnerTexts();
    const idx = labels.findIndex((t) => {
      const x = t.trim();
      return x === termLabel || x.includes(termLabel);
    });
    if (idx < 0) throw new Error(`Term "${termLabel}" not found in native <select> options`);
    await sel.selectOption({ index: idx });
  }

  await clickContinueAfterTerm(page);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

/**
 * Laurier/Banner term step varies: native <select>, Select2, or already skipped if session
 * remembers the wizard. We avoid relying on the exact string "Select a term..." only.
 */
async function selectTerm(page: Page, termLabel: string) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);

  if (await termStepAlreadyComplete(page)) return;

  await page
    .getByText(/Terms Open for Registration|Registration/i)
    .first()
    .waitFor({ state: "visible", timeout: 25_000 })
    .catch(() => {});

  if (await termStepAlreadyComplete(page)) return;

  if (await selectNativeTermSelect(page, termLabel)) return;

  const openers: Locator[] = [
    page.getByRole("combobox", { name: /term/i }),
    page.getByText(/^Select a term\.{0,3}$/i),
    page.getByText(/Select a term/i),
    page.getByText(/Choose a term/i),
    page.locator("span.select2-chosen").filter({ hasText: /Select a term|Select Term/i }),
    page.locator("a.select2-choice").first(),
    page.locator(".select2-container a.select2-choice").first(),
  ];

  let opened = false;
  for (const loc of openers) {
    const el = loc.first();
    if (await el.isVisible().catch(() => false)) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await el.click({ timeout: 5000 });
        opened = true;
        break;
      } catch {
        // try next opener
      }
    }
  }

  if (!opened) {
    const fuzzyRow = page.locator("div, button, a, span").filter({ hasText: /select.*term/i }).first();
    if (await fuzzyRow.isVisible().catch(() => false)) {
      await fuzzyRow.click();
      opened = true;
    }
  }

  if (!opened) {
    if (await termStepAlreadyComplete(page)) return;
    throw new Error(
      "TERM_PICKER_NOT_FOUND: Could not open the term dropdown after 'Register for Classes'. " +
        "Typical causes: session expired (try `npm run save-session`), a blocking popup, a different landing page, " +
        "or the portal UI changed. If it keeps happening, send the **URL in the address bar** after the failure plus a screenshot.",
    );
  }

  await page.waitForTimeout(300);

  const search = page
    .locator(".select2-drop-active input.select2-input, .select2-search input, input[type='search']")
    .first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(termLabel);
    await page.waitForTimeout(250);
  }

  const exactOpt = page.getByRole("option", { name: termLabel, exact: true }).first();
  if (await exactOpt.isVisible().catch(() => false)) {
    await exactOpt.click();
  } else {
    const loose = page.getByRole("option", { name: new RegExp(escapeRegex(termLabel), "i") }).first();
    if (await loose.isVisible().catch(() => false)) {
      await loose.click();
    } else {
      await page
        .locator("[role='option'], .select2-results li.select2-result-selectable, .select2-results li")
        .filter({ hasText: new RegExp("^\\s*" + escapeRegex(termLabel) + "\\s*$", "i") })
        .first()
        .click({ timeout: 15_000 });
    }
  }

  await page.waitForTimeout(400);
  await clickContinueAfterTerm(page);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
}

async function ensureFindClassesTab(page: Page) {
  const tab = page.getByRole("tab", { name: /Find Classes/i }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
  } else {
    await page.getByText("Find Classes", { exact: false }).first().click();
  }
}

async function waitVisibleEnabled(loc: Locator, label: string, timeout = 25_000) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.waitFor({ state: "visible", timeout });
  if (!(await loc.isEnabled().catch(() => false))) {
    throw new Error(`${label} field is visible but not enabled`);
  }
}

async function firstVisible(page: Page, selector: string): Promise<Locator | null> {
  const all = page.locator(selector);
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/**
 * Subject on Banner is often Select2. The search `input.select2-input` may stay CSS-hidden while
 * still focused (`aria-expanded=true`); waiting only for `.select2-drop-active` can time out.
 */
async function fillSelect2Subject(page: Page, subject: string) {
  const trigger = page.locator("#s2id_txt_subject").first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 });
  await trigger.click();

  const drop = page.locator("#select2-drop, .select2-drop").first();
  await drop.waitFor({ state: "attached", timeout: 15_000 });
  await drop.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

  const search = drop.locator("input.select2-input").first();
  await search.waitFor({ state: "attached", timeout: 10_000 });
  await search.fill(subject, { force: true });

  const opt = drop
    .locator(".select2-results li.select2-result-selectable, [role='option']")
    .filter({ hasText: new RegExp("^\\s*" + escapeRegex(subject) + "\\b", "i") })
    .first();
  await opt.waitFor({ state: "visible", timeout: 15_000 });
  await opt.click();
}

/**
 * Laurier/Banner often exposes a hidden `input#subject.subject-header` tied to the
 * same accessible name as the real search box. Do NOT use getByLabel(/^Subject$/i)
 * here — prefer `#txt_subject` / Select2, then plain textboxes in the search panel.
 */
async function fillCourseSearch(page: Page, subject: string, courseNumber: string) {
  await ensureFindClassesTab(page);

  await page
    .getByText("Enter Your Search Criteria", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);

  const visibleSubject =
    (await firstVisible(page, "#txt_subject")) ??
    (await firstVisible(page, "input[name='txt_subject']"));

  if (visibleSubject) {
    await waitVisibleEnabled(visibleSubject, "Subject");
    await visibleSubject.fill(subject);
  } else if (await page.locator("#s2id_txt_subject").first().isVisible().catch(() => false)) {
    await fillSelect2Subject(page, subject);
  } else {
    const inPanel = page
      .locator(
        "#classSearchSearchFields #txt_subject, #classSearchSearchFieldsAdvanced #txt_subject, #classSearchSearchFields input#txt_subject",
      )
      .first();
    if (await inPanel.isVisible().catch(() => false)) {
      await waitVisibleEnabled(inPanel, "Subject (search panel)");
      await inPanel.fill(subject);
    } else {
      throw new Error(
        "Could not find a visible Subject control. Expected #txt_subject or #s2id_txt_subject (Select2). " +
          "Run: npx playwright codegen https://loris.wlu.ca/register/ssb/registration",
      );
    }
  }

  const courseEl =
    (await firstVisible(page, "#txt_courseNumber")) ??
    (await firstVisible(page, "input[name='txt_courseNumber']")) ??
    (await firstVisible(page, "input[name='txt_course_number']"));

  if (!courseEl) {
    throw new Error(
      "Could not find a visible Course Number field (#txt_courseNumber). " +
        "Run: npx playwright codegen https://loris.wlu.ca/register/ssb/registration",
    );
  }
  await waitVisibleEnabled(courseEl, "Course number");
  await courseEl.fill(courseNumber);

  const searchBtn = page.getByRole("button", { name: /^Search$/i }).first();
  await searchBtn.click();

  await page.waitForTimeout(1500);
}

async function scrapeResults(page: Page, req: WatchRequest): Promise<SeatSummary[]> {
  const subjectNorm = req.subject.trim().toUpperCase();
  const courseNorm = req.courseNumber.trim();
  const crnFilter = req.crn?.trim();

  const table = page.locator("table").filter({ hasText: /CRN/i }).first();
  await table.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});

  const rows = table.locator("tbody tr, tr").filter({ hasText: new RegExp(courseNorm, "i") });
  const count = await rows.count();
  const results: SeatSummary[] = [];

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const cells = row.locator("td, th");
    const n = await cells.count();
    if (n < 4) continue;

    const texts: string[] = [];
    for (let c = 0; c < n; c++) {
      texts.push((await cells.nth(c).innerText()).replace(/\s+/g, " ").trim());
    }

    // Heuristic: locate CRN and Class Seats columns by header scan on first row of thead if present
    const headerRow = table.locator("thead tr").first();
    let crnIdx = -1;
    let seatsIdx = -1;
    let subjIdx = -1;
    let courseIdx = -1;
    let sectionIdx = -1;
    let titleIdx = -1;

    if (await headerRow.isVisible().catch(() => false)) {
      const headers = headerRow.locator("th");
      const hc = await headers.count();
      for (let h = 0; h < hc; h++) {
        const label = (await headers.nth(h).innerText()).replace(/\s+/g, " ").trim();
        if (/^CRN$/i.test(label)) crnIdx = h;
        if (/class seat/i.test(label)) seatsIdx = h;
        if (/^subject$/i.test(label) && subjIdx === -1) subjIdx = h;
        if (/^course$/i.test(label)) courseIdx = h;
        if (/^section$/i.test(label)) sectionIdx = h;
        if (/^title$/i.test(label)) titleIdx = h;
      }
    }

    const pick = (idx: number, fallback: string) =>
      idx >= 0 && idx < texts.length ? texts[idx] : fallback;

    const crn = crnIdx >= 0 ? pick(crnIdx, "") : "";
    const seatsText = seatsIdx >= 0 ? pick(seatsIdx, "") : texts.join(" | ");
    const subj = subjIdx >= 0 ? pick(subjIdx, "") : "";
    const course = courseIdx >= 0 ? pick(courseIdx, "") : "";
    const section = sectionIdx >= 0 ? pick(sectionIdx, "") : "";
    const title = titleIdx >= 0 ? pick(titleIdx, "") : "";

    if (!crn && !course) continue;

    if (crnFilter && crn && crn !== crnFilter) continue;
    if (!crnFilter) {
      const subjOk = subj.toUpperCase().includes(subjectNorm) || texts.some((t) => t.toUpperCase().includes(subjectNorm));
      const courseOk = course === courseNorm || texts.some((t) => new RegExp(`\\b${courseNorm}\\b`).test(t));
      if (!subjOk || !courseOk) continue;
    }

    const parsed = parseSeatsCell(seatsText);
    results.push({
      subject: subj || subjectNorm,
      courseNumber: course || courseNorm,
      section,
      crn: crn || crnFilter || "",
      title,
      seatsText,
      ...parsed,
    });
  }

  return results;
}

/**
 * Detect real login / SSO walls — NOT the normal LORIS hub, which always shows links like
 * "Guest Sign In" (matched our old /sign in|session/ heuristics and caused false SESSION_OR_LOGIN).
 *
 * Authenticated Banner flows live under `…/register/ssb/…` (e.g. termSelection, classSearch). Those
 * screens can still contain a visible `input[type=password]` (extensions, quirks) — never treat
 * that alone as “logged out” on those URLs.
 */
async function looksLikeLoginOrSessionDead(page: Page): Promise<boolean> {
  const url = page.url();

  if (
    /microsoftonline\.com|login\.live\.|okta\.com|duosecurity\.com|adfs\.|shibboleth|\/cas\/login|\/idp\/profile|password\/secure\/|\/saml2?\/sso\//i.test(
      url,
    )
  ) {
    return true;
  }

  // Laurier SSB registration SPA (term pick, class search, etc.)
  if (/loris\.wlu\.ca\/register\/ssb\//i.test(url)) {
    const hardSessionFail = page.getByText(
      /your session has expired|session has timed out|invalid session|you have been logged out|please sign in again|please log in again/i,
    );
    return await hardSessionFail.first().isVisible().catch(() => false);
  }

  if (/loris\.wlu\.ca/i.test(url) && /\/(login|signin|authenticate)(\/|$|\?)/i.test(url)) {
    return true;
  }

  const pw = page.locator("input[type='password']").first();
  if (await pw.isVisible().catch(() => false)) {
    return true;
  }

  const hardSessionFail = page.getByText(
    /your session has expired|session has timed out|invalid session|you have been logged out|please sign in again|please log in again/i,
  );
  if (await hardSessionFail.first().isVisible().catch(() => false)) {
    return true;
  }

  return false;
}

async function maybeDebugSnapshot(page: Page | null, debug: boolean) {
  if (!debug || !page) return;
  const dir = path.resolve(process.cwd(), ".cache");
  await mkdir(dir, { recursive: true }).catch(() => {});
  const shot = path.join(dir, "loris-debug.png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  const url = page.url();
  const title = await page.title().catch(() => "");
  console.error(`[LORIS debug] url=${url}\n[LORIS debug] title=${title}\n[LORIS debug] screenshot=${shot}`);
}

export type CheckLorisOptions = {
  headless?: boolean;
  /** Write .cache/loris-debug.png and print URL/title on failure */
  debug?: boolean;
};

export async function checkLoris(
  storageStatePath: string,
  req: WatchRequest,
  options?: CheckLorisOptions,
): Promise<CheckResult> {
  const resolvedStorage = path.isAbsolute(storageStatePath)
    ? storageStatePath
    : path.resolve(process.cwd(), storageStatePath);

  if (!existsSync(resolvedStorage)) {
    return {
      termLabel: req.termLabel,
      subject: req.subject,
      courseNumber: req.courseNumber,
      matched: [],
      error: "STORAGE_STATE_MISSING",
    };
  }

  const headless = options?.headless ?? true;
  const debug = options?.debug ?? false;
  const browser = await chromium.launch({ headless });
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const base = (): CheckResult => ({
    termLabel: req.termLabel,
    subject: req.subject,
    courseNumber: req.courseNumber,
    matched: [],
  });

  try {
    context = await browser.newContext({
      storageState: resolvedStorage,
    });
    page = await context.newPage();
    await gotoRegistration(page);

    if (await looksLikeLoginOrSessionDead(page)) {
      await maybeDebugSnapshot(page, debug);
      return {
        ...base(),
        error: "SESSION_OR_LOGIN",
        detail: `After landing: ${page.url()}`,
      };
    }

    await clickRegisterForClasses(page);

    if (await looksLikeLoginOrSessionDead(page)) {
      await maybeDebugSnapshot(page, debug);
      return {
        ...base(),
        error: "SESSION_OR_LOGIN",
        detail: `After Register for Classes: ${page.url()}`,
      };
    }

    await selectTerm(page, req.termLabel);
    await fillCourseSearch(page, req.subject, req.courseNumber);

    if (await looksLikeLoginOrSessionDead(page)) {
      await maybeDebugSnapshot(page, debug);
      return {
        ...base(),
        error: "SESSION_OR_LOGIN",
        detail: `After search form: ${page.url()}`,
      };
    }

    const matched = await scrapeResults(page, req);
    return {
      termLabel: req.termLabel,
      subject: req.subject,
      courseNumber: req.courseNumber,
      matched,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    await maybeDebugSnapshot(page, debug);
    return {
      ...base(),
      error: "FLOW_FAILED",
      detail: [message, stack].filter(Boolean).join("\n"),
    };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
