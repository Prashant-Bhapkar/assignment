/**
 * The surface seam.
 *
 * Everything above this interface — the agent loop, the replay engine, the
 * artifact — is written against `Surface` and never touches Playwright, a DOM,
 * or coordinates directly. A `Surface` implementation knows how to:
 *   - perceive its current state in a model-legible form (`observe`)
 *   - resolve a surface-agnostic `TargetSelector` to something actionable
 *   - perform the low-level action primitives
 *   - evaluate a `Check`
 *
 * The web implementation lives in ./web. A legacy-web or desktop implementation
 * would satisfy the same interface (see REPORT.md §4).
 */
import type { Check, FrameRef, TargetSelector } from '../artifact/schema.js';

export type ElementKind = 'button' | 'link' | 'textbox' | 'combobox' | 'checkbox' | 'radio' | 'cell' | 'other';

/** A rich, capture-time description of one interactive element. Used by the agent
 *  to choose an element and by artifact synthesis to derive robust locators. */
export interface InteractableDescriptor {
  ref: string; // per-observation handle, e.g. "e12" — NOT stable across observations
  kind: ElementKind;
  role: string;
  name: string; // accessible name
  label?: string; // associated / nearby <label> text
  placeholder?: string;
  text?: string; // visible text content
  title?: string;
  altText?: string;
  frame: FrameRef;
  attrs: { id?: string; name?: string; testId?: string; type?: string; href?: string };
  cssCandidates: string[]; // ranked, most→least specific-but-stable
  nearbyText?: string; // short context string for `nearText` locators
  rowCells?: string[]; // for table cells: sibling cell texts in the same row
  colIndex?: number; // for table cells: 0-based column index in the row
  disabled?: boolean;
}

export interface Observation {
  url: string;
  title: string;
  httpStatus?: number; // status of the main document response, if known
  a11yTree: string; // ARIA snapshot of the page (model-legible)
  interactables: InteractableDescriptor[]; // things the agent can act on
  readables: InteractableDescriptor[]; // inert text regions the agent can read (table cells, values)
  frames: { name?: string; url: string }[];
  visibleText: string; // truncated visible-text digest
  dialogOpen?: { type: string; message: string };
  screenshotPath?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  navigated?: boolean;
  urlAfter: string;
}

export interface ResolvedTarget {
  strategyIndex: number;
  strategyKind: string;
  matchCount: number;
  /** opaque handle the surface can act on (e.g. a Playwright Locator) */
  handle: unknown;
}

export type ResolveOutcome =
  | { found: true; target: ResolvedTarget; attempts: ResolveAttempt[] }
  | { found: false; attempts: ResolveAttempt[] };

export interface ResolveAttempt {
  strategyIndex: number;
  strategyKind: string;
  matchCount: number;
  error?: string;
}

export interface Surface {
  readonly kind: 'web' | 'legacy-web' | 'desktop';

  start(entryUrl: string): Promise<void>;
  close(): Promise<void>;

  observe(opts?: { screenshot?: boolean }): Promise<Observation>;
  screenshot(path: string): Promise<void>;
  domSnapshot(): Promise<string>;

  navigate(url: string): Promise<ActionResult>;
  click(target: ResolvedTarget): Promise<ActionResult>;
  fill(target: ResolvedTarget, text: string, opts?: { clearFirst?: boolean; pressEnter?: boolean }): Promise<ActionResult>;
  selectOption(target: ResolvedTarget, value: string): Promise<ActionResult>;
  press(key: string): Promise<ActionResult>;
  /** Respond to a pending native dialog (alert/confirm/beforeunload). */
  answerDialog(accept: boolean): Promise<ActionResult>;

  resolve(selector: TargetSelector): Promise<ResolveOutcome>;
  readValue(selector: TargetSelector, attribute: 'text' | 'innerText' | 'value' | 'href'): Promise<string | null>;

  evaluate(check: Check): Promise<{ pass: boolean; detail: string }>;
  currentUrl(): string;
  recentHttpStatuses(): { url: string; status: number }[];

  /** Hand the underlying live session to a human (see escalation). The headed
   *  browser window stays open for the operator; automation must not act until
   *  `waitForResume()` resolves. */
  cedeControl(): Promise<HandoffControl>;
}

export interface HandoffControl {
  operatorUrl: string;
  setContext(ctx: { title: string; body: string }): void;
  waitForResume(): Promise<{ notes: string; humanActions: { t: string; kind: string; detail: string }[]; durationMs: number }>;
  release(): Promise<void>;
}
