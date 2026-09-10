import type { Observation } from '../surface/types.js';

export function systemPrompt(goal: string, params: Record<string, string>, maxSteps: number): string {
  const paramLines = Object.keys(params).length
    ? Object.entries(params)
        .map(([k, v]) => `  - ${k} = ${JSON.stringify(v)}`)
        .join('\n')
    : '  (none)';
  return `You are a careful back-office operator automating a legacy web application that has no API.
You drive the UI the way a trained human operator would: observe the screen, take ONE action, observe again.

GOAL
${goal}

INPUT PARAMETERS (use these exact values where the goal calls for them)
${paramLines}

RULES
- Exactly one tool call per turn. After each action you receive a fresh observation.
- Only act on elements present in the most recent observation, addressed by their "ref" (e.g. e7).
- Prefer the most direct correct path. Do not explore unnecessarily.
- If the goal asks you to READ or LOOK UP a value, you MUST use the "extract" tool to record it as a
  typed output before calling finish. Choose a clear snake_case output_name.
- Treat "Submit", "Confirm", "Post", "Approve" style buttons as irreversible. Only click them if the
  goal explicitly requires completing that action. The system may ask a human to confirm.
- A legitimate business result (e.g. "no such member", "not authorized", a validation error) is a valid
  outcome: report it via finish with status="stuck" and explain — do NOT keep retrying.
- If you are genuinely blocked or a step is unsafe to take alone, call "escalate".
- Budget: at most ${maxSteps} steps. Be efficient.

For every action tool, provide "intent" (why) and, where sensible, "expectation" (what should be true
on screen afterward). These are recorded into a reusable capability, so be precise.`;
}

export function renderObservation(obs: Observation, note?: string): string {
  const interactables = obs.interactables
    .map((it) => {
      const bits = [
        `[${it.ref}]`,
        it.kind,
        it.name ? `name=${JSON.stringify(it.name)}` : '',
        it.label && it.label !== it.name ? `label=${JSON.stringify(it.label)}` : '',
        it.placeholder ? `placeholder=${JSON.stringify(it.placeholder)}` : '',
        it.attrs.type ? `type=${it.attrs.type}` : '',
        it.frame.kind !== 'main' ? `frame=${JSON.stringify(it.frame)}` : '',
        it.disabled ? 'DISABLED' : '',
      ].filter(Boolean);
      return '  ' + bits.join(' ');
    })
    .join('\n');

  const readables = obs.readables
    .map((it) => `  [${it.ref}] ${it.text ? JSON.stringify(it.text) : ''}${it.nearbyText && it.nearbyText !== it.text ? `  (row: ${JSON.stringify(it.nearbyText)})` : ''}${it.frame.kind !== 'main' ? ` frame=${JSON.stringify(it.frame)}` : ''}`)
    .join('\n');

  return `${note ? `NOTE: ${note}\n\n` : ''}URL: ${obs.url}
TITLE: ${obs.title}
${obs.httpStatus ? `HTTP STATUS: ${obs.httpStatus}\n` : ''}${obs.dialogOpen ? `OPEN DIALOG (${obs.dialogOpen.type}): ${obs.dialogOpen.message}\n` : ''}
INTERACTIVE ELEMENTS (act on these with click/type/select — use the ref):
${interactables || '  (none)'}

READABLE VALUES (read these with extract — use the ref):
${readables || '  (none)'}

VISIBLE TEXT (truncated):
${obs.visibleText.slice(0, 2500)}

ACCESSIBILITY TREE (truncated):
${obs.a11yTree.slice(0, 1500)}`;
}
