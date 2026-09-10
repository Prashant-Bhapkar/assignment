/**
 * Mock "Meridian Core" credit-union servicing console.
 *
 * A deliberately legacy, API-less stand-in for a real bank back-office app:
 * server-rendered, table-based, no test IDs, balances behind an iframe, cookie
 * sessions. It also exposes a control channel (`POST /_control`) to INJECT the
 * runtime error / exceptional states the brief calls out (record-not-found,
 * permission denial, unexpected interstitial, session timeout, slow load, app
 * error) so replay error-handling can be demonstrated deterministically.
 *
 * Nothing here is real. Do not point this at real data.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  MEMBERS,
  RESTRICTED_MEMBER_ID,
  findMembers,
  formatUsd,
  nextSubAccountNumber,
} from './data.js';
import * as V from './render.js';

const PORT = Number(process.env.MOCK_APP_PORT ?? 4599);

type InjectFlag =
  | 'none'
  | 'slow'
  | 'session_timeout'
  | 'maintenance_interstitial'
  | 'app_error'
  | 'deny_all_members';

/** Global injected condition. Set via POST /_control. Some flags are one-shot. */
const inject: { flag: InjectFlag; armed: boolean } = { flag: 'none', armed: false };

const sessions = new Map<string, { user: string; createdAt: number; ackedMaintenance: boolean }>();

const app = express();
app.use(express.urlencoded({ extended: false }));

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  (header ?? '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function getSession(req: express.Request) {
  const sid = parseCookies(req.headers.cookie)['mac_session'];
  return sid ? sessions.get(sid) : undefined;
}

/** Consume a one-shot inject flag if it matches; returns true if it fired. */
function fireOnce(flag: InjectFlag): boolean {
  if (inject.flag === flag && inject.armed) {
    inject.armed = false;
    return true;
  }
  return false;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Control channel (test harness only; not part of the "app" surface) ----
app.get('/_control', (_req, res) => {
  res.type('html').send(
    V.page('Control', `<h2>Inject control</h2>
    <form method="POST" action="/_control">
      <select name="flag">
        ${['none', 'slow', 'session_timeout', 'maintenance_interstitial', 'app_error', 'deny_all_members']
          .map((f) => `<option value="${f}"${inject.flag === f ? ' selected' : ''}>${f}</option>`)
          .join('')}
      </select>
      <input type="submit" value="Arm">
    </form>
    <p>Current: <b>${inject.flag}</b> (armed: ${String(inject.armed)})</p>`, { bare: true }),
  );
});

app.post('/_control', (req, res) => {
  const flag = String(req.body.flag ?? 'none') as InjectFlag;
  inject.flag = flag;
  inject.armed = flag !== 'none';
  res.json({ ok: true, flag: inject.flag, armed: inject.armed });
});

// ---- Auth ----
app.get('/', (req, res) => res.redirect(getSession(req) ? '/dashboard' : '/login'));

app.get('/login', (req, res) => {
  const notice = req.query.reason === 'timeout' ? 'Your session timed out. Please sign in again.' : undefined;
  res.type('html').send(V.loginPage(undefined, notice));
});

app.post('/login', (req, res) => {
  const { userid, password } = req.body as { userid?: string; password?: string };
  if (userid === 'operator' && password === 'password123') {
    const sid = randomUUID();
    sessions.set(sid, { user: userid, createdAt: Date.now(), ackedMaintenance: false });
    res.setHeader('Set-Cookie', `mac_session=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    return res.redirect('/dashboard');
  }
  res.status(401).type('html').send(V.loginPage('Invalid user ID or password.'));
});

app.get('/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie)['mac_session'];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', 'mac_session=; Path=/; Max-Age=0');
  res.redirect('/login');
});

// ---- Auth gate for everything below ----
app.use((req, res, next) => {
  const session = getSession(req);
  if (!session) return res.status(440).type('html').send(V.errorPage('session', 'Your session has ended. Please sign in again.'));

  if (fireOnce('session_timeout')) {
    const sid = parseCookies(req.headers.cookie)['mac_session'];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'mac_session=; Path=/; Max-Age=0');
    return res.status(440).type('html').send(V.errorPage('session', 'Your session has timed out due to inactivity. Please sign in again.'));
  }
  (req as any).session = session;
  next();
});

app.post('/_ack', (req, res) => {
  const session = (req as any).session as { ackedMaintenance: boolean };
  session.ackedMaintenance = true;
  const returnTo = typeof req.body.returnTo === 'string' && req.body.returnTo.startsWith('/') ? req.body.returnTo : '/dashboard';
  res.redirect(returnTo);
});

app.get('/dashboard', (_req, res) => res.type('html').send(V.dashboardPage()));

// ---- Member search ----
app.get('/members', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const searched = 'q' in req.query;
  const results = findMembers(q).map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`, branch: m.branch }));
  res.type('html').send(V.searchPage(q, results, searched));
});

// ---- Member detail ----
app.get('/members/:id', async (req, res) => {
  const session = (req as any).session as { ackedMaintenance: boolean };
  const { id } = req.params;

  if (inject.flag === 'slow' && inject.armed) {
    inject.armed = false;
    await delay(4000);
  }
  if (fireOnce('app_error')) {
    return res.status(500).type('html').send(V.errorPage('app-error', 'An unexpected error occurred (ref 0x5F3A). The transaction was not completed.'));
  }
  if (fireOnce('maintenance_interstitial') && !session.ackedMaintenance) {
    return res.type('html').send(V.maintenanceInterstitial(`/members/${id}`));
  }
  if ((inject.flag === 'deny_all_members' && inject.armed) || id === RESTRICTED_MEMBER_ID) {
    return res.status(403).type('html').send(V.errorPage('permission', `You do not have authorization to view member #${id}. Contact your supervisor to request elevated access.`));
  }

  const m = MEMBERS[id];
  if (!m) {
    return res.status(404).type('html').send(V.errorPage('not-found', `No member exists with ID "${id}".`));
  }
  res.type('html').send(V.memberDetailPage(m));
});

// ---- Iframe: account summary (balances) ----
app.get('/members/:id/summary', (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).type('html').send(V.errorPage('not-found', 'Account summary unavailable.'));
  res.type('html').send(
    V.memberSummaryFrame(
      m.accounts.map((a) => ({
        number: a.number,
        type: a.type,
        status: a.status,
        balance: formatUsd(a.balanceCents),
        openedOn: a.openedOn,
      })),
    ),
  );
});

// ---- Open sub-account (multi-step form -> review -> confirm) ----
app.get('/members/:id/sub-account/new', (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).type('html').send(V.errorPage('not-found', `No member exists with ID "${req.params.id}".`));
  res.type('html').send(V.subAccountFormPage(m.id, `${m.firstName} ${m.lastName}`, undefined, {}));
});

function validateSubAccount(body: Record<string, string>): { ok: true; fields: { product: string; nickname: string; initialDeposit: string } } | { ok: false; error: string } {
  const product = (body.product ?? '').trim();
  const nickname = (body.nickname ?? '').trim();
  const raw = (body.initialDeposit ?? '').trim();
  if (!product) return { ok: false, error: 'Product is required.' };
  const amount = Number(raw.replace(/[$,]/g, ''));
  if (!raw || Number.isNaN(amount)) return { ok: false, error: 'Initial deposit must be a number.' };
  if (amount < 0) return { ok: false, error: 'Initial deposit cannot be negative.' };
  if (amount > 10000) return { ok: false, error: 'Initial deposit exceeds the $10,000 limit for operator-opened accounts.' };
  return { ok: true, fields: { product, nickname, initialDeposit: formatUsd(Math.round(amount * 100)) } };
}

app.post('/members/:id/sub-account/review', (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).type('html').send(V.errorPage('not-found', `No member exists with ID "${req.params.id}".`));
  const name = `${m.firstName} ${m.lastName}`;
  const v = validateSubAccount(req.body);
  if (!v.ok) return res.status(422).type('html').send(V.subAccountFormPage(m.id, name, v.error, req.body));
  res.type('html').send(V.subAccountReviewPage(m.id, name, v.fields));
});

app.post('/members/:id/sub-account/confirm', (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).type('html').send(V.errorPage('not-found', `No member exists with ID "${req.params.id}".`));
  const name = `${m.firstName} ${m.lastName}`;
  const v = validateSubAccount(req.body);
  if (!v.ok) return res.status(422).type('html').send(V.subAccountFormPage(m.id, name, v.error, req.body));
  const acct = nextSubAccountNumber(m.id);
  res.type('html').send(V.subAccountConfirmationPage(m.id, name, acct, { product: v.fields.product, initialDeposit: v.fields.initialDeposit }));
});

app.use((_req, res) => res.status(404).type('html').send(V.errorPage('not-found', 'Page not found.')));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-app] Meridian Core listening on http://localhost:${PORT}  (login: operator / password123)`);
});
