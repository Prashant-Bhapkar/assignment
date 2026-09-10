/**
 * Web `Surface` implementation backed by Playwright + Chromium.
 *
 * This is the one concrete surface the project implements. It is deliberately
 * the only file that imports Playwright.
 */
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Dialog, Locator, Page } from 'playwright';
import type { Check, TargetSelector } from '../../artifact/schema.js';
import type { ActionResult, Observation, ResolveOutcome, ResolvedTarget, Surface } from '../types.js';
import { perceive } from './perception.js';
import { resolveFrame, resolveTarget } from './locator.js';

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  slowMoMs?: number;
  defaultTimeoutMs?: number;
  storageStatePath?: string; // pre-authenticated session for replay
}

export class PlaywrightSurface implements Surface {
  readonly kind = 'web' as const;
  private browser?: Browser;
  private context?: BrowserContext;
  private _page?: Page;
  private statuses: { url: string; status: number }[] = [];
  private pendingDialog?: Dialog;
  private handoffActive = false;

  constructor(private readonly opts: PlaywrightSurfaceOptions = {}) {}

  get page(): Page {
    if (!this._page) throw new Error('Surface not started');
    return this._page;
  }

  async start(entryUrl: string): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.opts.headless ?? false,
      slowMo: this.opts.slowMoMs ?? 0,
    });
    this.context = await this.browser.newContext(
      this.opts.storageStatePath ? { storageState: this.opts.storageStatePath } : {},
    );
    this.context.setDefaultTimeout(this.opts.defaultTimeoutMs ?? 15000);
    this._page = await this.context.newPage();

    this._page.on('response', (res) => {
      if (res.request().resourceType() === 'document') {
        this.statuses.push({ url: res.url(), status: res.status() });
        if (this.statuses.length > 25) this.statuses.shift();
      }
    });
    // Keep native dialogs pending so the agent/replay can decide. Auto-dismiss
    // after a grace period so a run can never hang on one.
    this._page.on('dialog', (dialog) => {
      this.pendingDialog = dialog;
      setTimeout(() => {
        if (this.pendingDialog === dialog) {
          dialog.dismiss().catch(() => {});
          this.pendingDialog = undefined;
        }
      }, 30000);
    });

    if (entryUrl) await this.navigate(entryUrl);
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }

  async observe(opts: { screenshot?: boolean } = {}): Promise<Observation> {
    const obs = await perceive(this.page);
    obs.httpStatus = this.statuses.at(-1)?.status;
    if (this.pendingDialog) {
      obs.dialogOpen = { type: this.pendingDialog.type(), message: this.pendingDialog.message() };
    }
    return obs;
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path }).catch(() => {});
  }

  async domSnapshot(): Promise<string> {
    return this.page.content().catch(() => '');
  }

  private result(ok: boolean, error?: string): ActionResult {
    return { ok, error, urlAfter: this.page.url() };
  }

  async navigate(url: string): Promise<ActionResult> {
    try {
      const res = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      if (res) this.statuses.push({ url: res.url(), status: res.status() });
      return this.result(true);
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
  }

  private loc(t: ResolvedTarget): Locator {
    return t.handle as Locator;
  }

  async click(target: ResolvedTarget): Promise<ActionResult> {
    try {
      await this.loc(target).click({ timeout: this.opts.defaultTimeoutMs ?? 15000 });
      await this.settle();
      return this.result(true);
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
  }

  async fill(target: ResolvedTarget, text: string, opts: { clearFirst?: boolean; pressEnter?: boolean } = {}): Promise<ActionResult> {
    try {
      const loc = this.loc(target);
      if (opts.clearFirst ?? true) await loc.fill(text);
      else await loc.pressSequentially(text);
      if (opts.pressEnter) {
        await loc.press('Enter');
        await this.settle();
      }
      return this.result(true);
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
  }

  async selectOption(target: ResolvedTarget, value: string): Promise<ActionResult> {
    try {
      await this.loc(target).selectOption({ label: value }).catch(async () => {
        await this.loc(target).selectOption(value);
      });
      return this.result(true);
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
  }

  async press(key: string): Promise<ActionResult> {
    try {
      await this.page.keyboard.press(key);
      await this.settle();
      return this.result(true);
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
  }

  async answerDialog(accept: boolean): Promise<ActionResult> {
    const d = this.pendingDialog;
    if (!d) return this.result(false, 'no pending dialog');
    try {
      if (accept) await d.accept();
      else await d.dismiss();
      this.pendingDialog = undefined;
      return this.result(true);
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  }

  async resolve(selector: TargetSelector): Promise<ResolveOutcome> {
    return resolveTarget(this.page, selector);
  }

  async readValue(selector: TargetSelector, attribute: 'text' | 'innerText' | 'value' | 'href'): Promise<string | null> {
    const outcome = await this.resolve(selector);
    if (!outcome.found) return null;
    const loc = outcome.target.handle as Locator;
    try {
      if (attribute === 'value') return await loc.inputValue();
      if (attribute === 'href') return await loc.getAttribute('href');
      return (await loc.innerText()).trim();
    } catch {
      try {
        return (await loc.textContent())?.trim() ?? null;
      } catch {
        return null;
      }
    }
  }

  async evaluate(check: Check): Promise<{ pass: boolean; detail: string }> {
    const a = check.assertion;
    try {
      switch (a.type) {
        case 'urlMatches': {
          const re = new RegExp(a.pattern);
          const url = this.page.url();
          return { pass: re.test(url), detail: `url=${url} pattern=${a.pattern}` };
        }
        case 'urlContains': {
          const url = this.page.url();
          return { pass: url.includes(a.value), detail: `url=${url} needle=${a.value}` };
        }
        case 'textPresent': {
          const frame = a.frame ? resolveFrame(this.page, a.frame) : this.page.mainFrame();
          if (!frame) return { pass: false, detail: 'frame not found' };
          const body = await frame.evaluate(() => document.body?.innerText ?? '');
          return { pass: body.includes(a.text), detail: `looking for "${a.text}"` };
        }
        case 'textAbsent': {
          const frame = a.frame ? resolveFrame(this.page, a.frame) : this.page.mainFrame();
          if (!frame) return { pass: true, detail: 'frame not found (treated absent)' };
          const body = await frame.evaluate(() => document.body?.innerText ?? '');
          return { pass: !body.includes(a.text), detail: `ensuring absent "${a.text}"` };
        }
        case 'elementVisible': {
          const o = await this.resolve(a.target);
          if (!o.found) return { pass: false, detail: 'element not resolved' };
          const vis = await (o.target.handle as Locator).isVisible();
          return { pass: vis, detail: `visible=${vis}` };
        }
        case 'elementCount': {
          const o = await this.resolve(a.target);
          const n = o.found ? o.target.matchCount : 0;
          const pass = a.op === 'gte' ? n >= a.value : a.op === 'lte' ? n <= a.value : n === a.value;
          return { pass, detail: `count=${n} ${a.op} ${a.value}` };
        }
      }
    } catch (err) {
      return { pass: false, detail: `check error: ${(err as Error).message}` };
    }
  }

  currentUrl(): string {
    return this.page.url();
  }

  recentHttpStatuses(): { url: string; status: number }[] {
    return [...this.statuses];
  }

  async cedeControl() {
    if (!this.context) throw new Error('surface not started');
    const { startHandoff } = await import('../../escalation/handoff-server.js');
    this.handoffActive = true;
    const session = await startHandoff(this.context, this.page);
    return {
      operatorUrl: session.operatorUrl,
      setContext: session.setContext,
      waitForResume: session.waitForResume,
      release: async () => {
        await session.stop();
        this.handoffActive = false;
      },
    };
  }
}
