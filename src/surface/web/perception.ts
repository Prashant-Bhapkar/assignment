/**
 * Web perception: turn the live page (all frames) into a compact, model-legible
 * observation. Accessibility-first — we lead with the ARIA snapshot and
 * accessible names because those signals are the ones most likely to survive on
 * a legacy app and to have an analogue on a desktop surface. Raw CSS paths are
 * collected too, but only as low-confidence fallbacks.
 *
 * Two element lists are produced:
 *   - interactables: things the agent can act on (links, buttons, fields)
 *   - readables:     things the agent can read (table cells, dt/dd values) —
 *                    needed because the data a goal asks for is usually inert text
 */
import type { Frame, Page } from 'playwright';
import type { FrameRef } from '../../artifact/schema.js';
import type { InteractableDescriptor, Observation } from '../types.js';

const MAX_TEXT = 3500;
const MAX_INTERACTABLES = 120;
const MAX_READABLES = 70;

function lastPathSegment(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).pop() ?? u.pathname;
  } catch {
    return url;
  }
}

function frameRefFor(frame: Frame, page: Page): FrameRef {
  if (frame === page.mainFrame()) return { kind: 'main' };
  const name = frame.name();
  if (name) return { kind: 'name', value: name };
  return { kind: 'urlContains', value: lastPathSegment(frame.url()) };
}

function describeFrame(f: FrameRef): string {
  switch (f.kind) {
    case 'main':
      return 'main';
    case 'name':
      return `name=${f.value}`;
    case 'urlContains':
      return `url~${f.value}`;
    case 'index':
      return `#${f.value}`;
    default:
      return 'main';
  }
}

/** Runs in the page. Collects interactive + readable elements with our signals. */
const COLLECT_FN = `() => {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return l.innerText.trim();
    }
    const wrap = el.closest('label');
    if (wrap) return wrap.innerText.trim();
    const cell = el.closest('td');
    if (cell && cell.previousElementSibling) {
      const t = cell.previousElementSibling.innerText.trim();
      if (t && t.length < 60) return t;
    }
    const prev = el.previousElementSibling;
    if (prev && ['LABEL','TD','TH','SPAN','B'].includes(prev.tagName)) {
      const t = prev.innerText.trim();
      if (t && t.length < 60) return t;
    }
    return undefined;
  };
  const cssCandidates = (el) => {
    const c = [];
    if (el.id) c.push('#' + CSS.escape(el.id));
    if (el.name) c.push(el.tagName.toLowerCase() + '[name="' + el.name + '"]');
    const type = el.getAttribute('type');
    if (type && ['submit','button','checkbox','radio'].includes(type) && el.value)
      c.push(el.tagName.toLowerCase() + '[type="' + type + '"][value="' + CSS.escape(el.value) + '"]');
    let node = el, path = [];
    while (node && node.nodeType === 1 && path.length < 5) {
      let seg = node.tagName.toLowerCase();
      if (node.parentElement) {
        const sibs = [...node.parentElement.children].filter(x => x.tagName === node.tagName);
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      path.unshift(seg);
      node = node.parentElement;
    }
    c.push(path.join(' > '));
    return c;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'td' || tag === 'th') return 'cell';
    if (tag === 'dd' || tag === 'dt') return 'term';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['submit','button','reset'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return 'other';
  };
  const kindOf = (role) => ({link:'link',button:'button',textbox:'textbox',combobox:'combobox',checkbox:'checkbox',radio:'radio',cell:'cell'}[role] || 'other');
  const accName = (el, role) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (role === 'button') return ((el.tagName === 'INPUT' && el.value) ? el.value : (el.innerText || el.textContent || '')).trim();
    if (role === 'link') return (el.innerText || el.textContent || '').trim();
    return labelFor(el) || el.getAttribute('placeholder') || el.getAttribute('title') || '';
  };
  const rowContext = (el) => {
    const row = el.closest('tr');
    if (row) return row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 140);
    const dl = el.closest('dl, table, fieldset, div');
    return (dl ? dl.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 140);
  };

  const interactables = [];
  let i = 0;
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [onclick]')) {
    if (!isVisible(el)) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && type === 'hidden') continue;
    const role = roleOf(el);
    interactables.push({
      idx: i++, kind: kindOf(role), role,
      name: accName(el, role).slice(0, 120),
      label: labelFor(el),
      placeholder: el.getAttribute('placeholder') || undefined,
      text: (el.innerText || '').trim().slice(0, 120) || undefined,
      title: el.getAttribute('title') || undefined,
      altText: el.getAttribute('alt') || undefined,
      attrs: {
        id: el.id || undefined, name: el.getAttribute('name') || undefined,
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
        type: el.getAttribute('type') || undefined, href: el.getAttribute('href') || undefined,
      },
      cssCandidates: cssCandidates(el),
      nearbyText: rowContext(el),
      disabled: !!el.disabled,
    });
    if (i >= ${MAX_INTERACTABLES}) break;
  }

  const readables = [];
  let j = 0;
  for (const el of document.querySelectorAll('td, th, dd, li')) {
    if (!isVisible(el)) continue;
    if (el.querySelector('a, button, input, select, textarea, table')) continue; // leaf cells only
    const txt = (el.innerText || '').trim();
    if (!txt || txt.length > 120) continue;
    const row = el.closest('tr');
    const rowCells = row ? [...row.children].map(c => (c.innerText || '').trim().slice(0, 60)) : [];
    const colIndex = row ? [...row.children].indexOf(el.closest('td,th') || el) : undefined;
    readables.push({
      idx: j++, kind: 'cell', role: roleOf(el),
      name: txt.slice(0, 120), text: txt.slice(0, 120),
      label: labelFor(el),
      attrs: { id: el.id || undefined },
      cssCandidates: cssCandidates(el),
      nearbyText: rowContext(el),
      rowCells, colIndex,
      disabled: false,
    });
    if (j >= ${MAX_READABLES}) break;
  }

  return {
    interactables, readables,
    visibleText: (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n').trim().slice(0, ${MAX_TEXT}),
  };
}`;

function toDescriptor(raw: any, fref: FrameRef): InteractableDescriptor {
  return {
    ref: '',
    kind: raw.kind,
    role: raw.role,
    name: raw.name ?? '',
    label: raw.label,
    placeholder: raw.placeholder,
    text: raw.text,
    title: raw.title,
    altText: raw.altText,
    frame: fref,
    attrs: raw.attrs ?? {},
    cssCandidates: raw.cssCandidates ?? [],
    nearbyText: raw.nearbyText,
    rowCells: raw.rowCells,
    colIndex: raw.colIndex,
    disabled: raw.disabled,
  };
}

export async function perceive(page: Page): Promise<Observation> {
  const frames = page.frames();
  const interactables: InteractableDescriptor[] = [];
  const readables: InteractableDescriptor[] = [];
  let visibleText = '';

  for (const frame of frames) {
    let data: { interactables: any[]; readables: any[]; visibleText: string };
    try {
      data = (await frame.evaluate(COLLECT_FN as any)) as any;
    } catch {
      continue;
    }
    const fref = frameRefFor(frame, page);
    for (const raw of data.interactables) interactables.push(toDescriptor(raw, fref));
    for (const raw of data.readables) readables.push(toDescriptor(raw, fref));
    if (frame === page.mainFrame()) visibleText = data.visibleText;
    else visibleText += `\n\n[frame ${describeFrame(fref)}]\n${data.visibleText}`;
  }

  interactables.forEach((it, n) => (it.ref = `e${n}`));
  readables.forEach((it, n) => (it.ref = `r${n}`));

  let a11yTree = '';
  try {
    a11yTree = (await page.locator('body').ariaSnapshot()).slice(0, 3500);
  } catch {
    a11yTree = '';
  }

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    a11yTree,
    interactables: interactables.slice(0, MAX_INTERACTABLES),
    readables: readables.slice(0, MAX_READABLES),
    frames: frames.map((f) => ({ name: f.name() || undefined, url: f.url() })),
    visibleText: visibleText.slice(0, MAX_TEXT + 1200),
  };
}
