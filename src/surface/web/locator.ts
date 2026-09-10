/**
 * Locator resolution for the web surface.
 *
 * Given a surface-agnostic `TargetSelector` (an ordered list of strategies), try
 * each strategy in order against the correct frame and return the first that
 * resolves to a usable element. Which strategy won is reported back so replay
 * evidence records how robust the match was.
 */
import type { Frame, Locator, Page } from 'playwright';
import type { FrameRef, LocatorStrategy, TargetSelector } from '../../artifact/schema.js';
import type { ResolveAttempt, ResolveOutcome } from '../types.js';

export function resolveFrame(page: Page, ref: FrameRef): Frame | undefined {
  if (ref.kind === 'main') return page.mainFrame();
  const frames = page.frames();
  if (ref.kind === 'name') return frames.find((f) => f.name() === ref.value);
  if (ref.kind === 'index') return frames[ref.value];
  if (ref.kind === 'urlContains') return frames.find((f) => f.url().includes(ref.value));
  return undefined;
}

function buildLocator(frame: Frame, s: LocatorStrategy): Locator | undefined {
  switch (s.kind) {
    case 'role':
      return frame.getByRole((s.role as any) ?? 'button', s.name ? { name: s.name, exact: s.exact ?? false } : undefined);
    case 'label':
      return s.name ? frame.getByLabel(s.name, { exact: s.exact ?? false }) : undefined;
    case 'placeholder':
      return s.name ? frame.getByPlaceholder(s.name, { exact: s.exact ?? false }) : undefined;
    case 'text':
      return s.name ? frame.getByText(s.name, { exact: s.exact ?? false }) : undefined;
    case 'altText':
      return s.name ? frame.getByAltText(s.name) : undefined;
    case 'title':
      return s.name ? frame.getByTitle(s.name) : undefined;
    case 'testId':
      return s.value ? frame.locator(`[data-testid=${JSON.stringify(s.value)}], [data-test=${JSON.stringify(s.value)}]`) : undefined;
    case 'css':
      return s.value ? frame.locator(s.value) : undefined;
    case 'xpath':
      return s.value ? frame.locator(`xpath=${s.value}`) : undefined;
    case 'nearText': {
      // The control/value physically nearest a label-ish element containing text.
      if (!s.name) return undefined;
      if (s.elementHint === 'cell') {
        return frame.locator(`xpath=//*[normalize-space(text())=${xpathLiteral(s.name)}]/following::td[1]`);
      }
      const tag = s.elementHint === 'select' ? 'select' : s.elementHint === 'button' ? 'button,input[type=submit]' : 'input,select,textarea';
      return frame
        .locator(
          `xpath=//*[normalize-space(text())=${xpathLiteral(s.name)}]/following::*[self::input or self::select or self::textarea or self::button][1]`,
        )
        .or(frame.locator(`${tag}`).filter({ hasText: s.name }));
    }
    default:
      return undefined;
  }
}

function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.replace(/'/g, "',\"'\",'")}')`;
}

export async function resolveTarget(page: Page, selector: TargetSelector): Promise<ResolveOutcome> {
  const attempts: ResolveAttempt[] = [];
  const frame = resolveFrame(page, selector.frame);
  if (!frame) {
    return { found: false, attempts: [{ strategyIndex: -1, strategyKind: 'frame', matchCount: 0, error: `frame not found: ${JSON.stringify(selector.frame)}` }] };
  }

  for (let i = 0; i < selector.strategies.length; i++) {
    const s = selector.strategies[i]!;
    try {
      let loc = buildLocator(frame, s);
      if (!loc) {
        attempts.push({ strategyIndex: i, strategyKind: s.kind, matchCount: 0, error: 'strategy not applicable (missing fields)' });
        continue;
      }
      if (selector.disambiguation) {
        if (selector.disambiguation.kind === 'first') loc = loc.first();
        else if (selector.disambiguation.kind === 'last') loc = loc.last();
        else if (selector.disambiguation.kind === 'nth') loc = loc.nth(selector.disambiguation.index);
        else if (selector.disambiguation.kind === 'withText') loc = loc.filter({ hasText: selector.disambiguation.text });
      }
      const count = await loc.count();
      if (count === 0) {
        attempts.push({ strategyIndex: i, strategyKind: s.kind, matchCount: 0 });
        continue;
      }
      const effective = selector.disambiguation ? loc : count > 1 ? loc.first() : loc;
      if (count > 1 && !selector.disambiguation) {
        // Ambiguous but not fatal — take first, record it.
        attempts.push({ strategyIndex: i, strategyKind: s.kind, matchCount: count, error: 'ambiguous; used first' });
      } else {
        attempts.push({ strategyIndex: i, strategyKind: s.kind, matchCount: count });
      }
      return {
        found: true,
        attempts,
        target: { strategyIndex: i, strategyKind: s.kind, matchCount: count, handle: effective },
      };
    } catch (err) {
      attempts.push({ strategyIndex: i, strategyKind: s.kind, matchCount: 0, error: (err as Error).message });
    }
  }
  return { found: false, attempts };
}
