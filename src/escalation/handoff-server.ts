/**
 * Handoff server — the real control-transfer mechanism.
 *
 * When automation escalates, it calls `surface.cedeControl()`, which starts one
 * of these against the SAME Playwright BrowserContext/Page the agent was using.
 * The headed Chromium window stays open; the human operates it directly. This
 * server:
 *   - serves a minimal operator console (the intervention context + a Resume button)
 *   - captures the human's actions in the live page (clicks / field edits /
 *     navigations) via an exposed binding + init script, so the run record shows
 *     what the human did
 *   - resolves `waitForResume()` when the operator hands control back
 *
 * A full co-browsing console (video, remote input) is explicitly out of scope
 * (see REPORT.md §5); the seam here is real and the control-transfer model is
 * complete.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { BrowserContext, Page } from 'playwright';

export interface HumanAction {
  t: string;
  kind: 'click' | 'input' | 'change' | 'submit' | 'navigate';
  detail: string;
}

export interface HandoffSession {
  operatorUrl: string;
  humanActions: HumanAction[];
  context: { title: string; body: string };
  setContext(ctx: { title: string; body: string }): void;
  waitForResume(): Promise<{ notes: string; humanActions: HumanAction[]; durationMs: number }>;
  stop(): Promise<void>;
}

const CAPTURE_SCRIPT = `(() => {
  if (window.__handoffCaptureInstalled) return;
  window.__handoffCaptureInstalled = true;
  const send = (kind, detail) => { try { window.__handoffRecord && window.__handoffRecord({ kind, detail }); } catch (e) {} };
  const label = (el) => {
    if (!el) return 'unknown';
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.name || el.id || el.tagName || '').toString().trim().slice(0, 60);
    return el.tagName + (t ? ' "' + t + '"' : '');
  };
  document.addEventListener('click', (e) => send('click', label(e.target)), true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    const isSecret = el && (el.type === 'password');
    send('change', label(el) + ' -> ' + (isSecret ? '«hidden»' : (el && String(el.value || '').slice(0, 40))));
  }, true);
  document.addEventListener('submit', (e) => send('submit', label(e.target)), true);
})();`;

let bindingInstalled = new WeakSet<BrowserContext>();

export async function startHandoff(context: BrowserContext, page: Page): Promise<HandoffSession> {
  const port = Number(process.env.OPERATOR_PORT ?? 4600);
  const humanActions: HumanAction[] = [];
  const startedAt = Date.now();
  let ctx = { title: 'Manual intervention required', body: 'Automation is paused.' };
  let resolveResume: (v: { notes: string; humanActions: HumanAction[]; durationMs: number }) => void;
  const resumePromise = new Promise<{ notes: string; humanActions: HumanAction[]; durationMs: number }>((r) => (resolveResume = r));

  if (!bindingInstalled.has(context)) {
    await context.exposeBinding('__handoffRecord', (_src, ev: { kind: HumanAction['kind']; detail: string }) => {
      humanActions.push({ t: new Date().toISOString(), kind: ev.kind, detail: ev.detail });
      // eslint-disable-next-line no-console
      console.log(`    [operator] ${ev.kind}: ${ev.detail}`);
    });
    await context.addInitScript(CAPTURE_SCRIPT);
    bindingInstalled.add(context);
  }
  await page.evaluate(CAPTURE_SCRIPT).catch(() => {});
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) humanActions.push({ t: new Date().toISOString(), kind: 'navigate', detail: f.url() });
  });

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><meta charset=utf-8>
<title>Operator Console — Intervention</title>
<body style="font-family:system-ui;margin:0;background:#12151b;color:#e7e9ee">
<div style="max-width:720px;margin:0 auto;padding:28px">
  <div style="font-size:12px;letter-spacing:2px;color:#8a93a6">OPERATOR CONSOLE · LIVE SESSION HANDOFF</div>
  <h1 style="font-size:20px;margin:6px 0 4px">${escapeHtml(ctx.title)}</h1>
  <pre style="white-space:pre-wrap;background:#1b2029;border:1px solid #2b3240;border-radius:8px;padding:14px;font-size:13px">${escapeHtml(ctx.body)}</pre>
  <p style="color:#8a93a6;font-size:13px">The automation is <b>paused</b>. Control of the live browser window is yours.
  Complete the manual step(s) in the Chromium window that is already open, then hand control back below.</p>
  <h3 style="font-size:14px;margin-top:22px">Actions captured so far</h3>
  <ul id="log" style="font-size:12px;color:#b7bECB"></ul>
  <form method="POST" action="/resume" style="margin-top:20px">
    <textarea name="notes" rows="3" placeholder="What did you do? (recorded into the run)" style="width:100%;background:#1b2029;color:#e7e9ee;border:1px solid #2b3240;border-radius:6px;padding:8px"></textarea>
    <button style="margin-top:10px;background:#2f6feb;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:14px;cursor:pointer">Resume automation</button>
  </form>
</div>
<script>
  setInterval(async () => {
    const r = await fetch('/actions'); const a = await r.json();
    document.getElementById('log').innerHTML = a.map(x => '<li>' + x.kind + ': ' + escapeHtml(x.detail) + '</li>').join('') || '<li style="color:#66707f">none yet</li>';
    function escapeHtml(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
  }, 1500);
</script>`);
  });

  app.get('/actions', (_req, res) => res.json(humanActions));

  app.post('/resume', (req, res) => {
    const notes = String(req.body.notes ?? '').slice(0, 2000);
    res.type('html').send('<meta charset=utf-8><body style="font-family:system-ui;background:#12151b;color:#e7e9ee;padding:28px">Control returned to automation. You can close this tab.</body>');
    resolveResume({ notes, humanActions, durationMs: Date.now() - startedAt });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });

  const operatorUrl = `http://localhost:${port}/`;
  // eslint-disable-next-line no-console
  console.log(`\n  ⚠  ESCALATION — human control required. Operator console: ${operatorUrl}\n`);

  return {
    operatorUrl,
    humanActions,
    context: ctx,
    setContext(next) {
      ctx = next;
    },
    waitForResume: () => resumePromise,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
