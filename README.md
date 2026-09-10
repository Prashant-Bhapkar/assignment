# Computer-Use Automation System

Give an AI agent hands inside a legacy back-office app that has no API: an LLM
works out how to complete a task in the live UI **once**, the successful run is
recorded as a typed, versioned **capability artifact**, and that artifact then
**replays deterministically** — no model in the decision loop — with input
parameters, typed outputs, an explicit runtime-error taxonomy, safety guardrails,
and a real human-escalation path that can take over the same live session.

> **The through-line:** the model discovers → the artifact is the reusable
> capability → deterministic replay is how a production agent invokes it.

See [`REPORT.md`](REPORT.md) for the design write-up and
[`evidence/`](evidence/) for logs + artifact from a real discovery run and
several replay runs (including failure cases).

---

## What's in the box

| Piece | Where | Notes |
|---|---|---|
| Mock target app ("Meridian Core" credit-union console) | [`src/mock-app/`](src/mock-app/) | Deliberately legacy: server-rendered, table layout, **no test IDs**, balances behind an `<iframe>`, cookie sessions. Injects runtime errors on demand. |
| Surface abstraction | [`src/surface/`](src/surface/) | `Surface` interface + one web implementation (Playwright). Everything above it is surface-agnostic. |
| Discovery agent loop | [`src/agent/`](src/agent/) | LLM-driven observe→decide→act (Anthropic tool use). Produces a `RunTrace`, not a transcript. |
| Capability artifact schema | [`src/artifact/schema.ts`](src/artifact/schema.ts) | The focal point. Zod-typed, versioned. |
| Artifact synthesis | [`src/artifact/synthesize.ts`](src/artifact/synthesize.ts) | Deterministic `RunTrace` → artifact compiler (locator strategy selection lives here). |
| Deterministic replay engine | [`src/replay/`](src/replay/) | No LLM. Result contract distinguishes success / business outcome / recoverable / hard failure. |
| Safety & policy | [`src/safety/`](src/safety/) | Allowlist, risk classification, redaction of secrets/PII. |
| Human escalation & handoff | [`src/escalation/`](src/escalation/) | Pause → operator console drives the **same** live session → resume, with human-action capture. |
| Capability catalog (stretch) | [`src/catalog/`](src/catalog/) | Saved artifacts exposed as typed, callable tools + an HTTP endpoint. |

---

## Setup

Requires **Node ≥ 20**.

```bash
npm install                 # also downloads Chromium for Playwright
cp .env.example .env        # then edit .env
```

`.env`:

```
ANTHROPIC_API_KEY=sk-ant-...   # required ONLY for `discover` (the LLM run)
# ANTHROPIC_MODEL=claude-sonnet-5
```

Replay, the mock app, the operator console, the catalog, and all tests run
**without any API key**.

```bash
npm run typecheck
npm test                    # spins up the mock app, exercises replay + error taxonomy (no LLM)
```

---

## Demo path

### 1. Start the mock target app (terminal 1)

```bash
npm run mock
# Meridian Core on http://localhost:4599  (login is scripted for you: operator / password123)
```

### 2. Run the discovery agent on a goal (terminal 2)

```bash
npm run cli -- discover \
  --goal "look up member 12345 and read their current savings balance" \
  --param memberId=12345 \
  --capability-id meridian-core.member.read_savings_balance
```

This drives the real browser with the LLM, and on success writes:

* `artifacts/meridian-core.member.read_savings_balance/1.0.0.json` — the capability
* `evidence/discovery-<timestamp>/` — event log, trace, transcript, screenshots

### 3. Replay the capability deterministically (no LLM)

```bash
npm run cli -- replay \
  --artifact artifacts/meridian-core.member.read_savings_balance/1.0.0.json \
  --param memberId=12345
```

Prints a structured `success` result with the typed `savings_balance` output.

### 4. Replay into error / exceptional states

```bash
# expected BUSINESS OUTCOME — not a crash:
npm run cli -- replay --artifact <path> --param memberId=00000        # -> MEMBER_NOT_FOUND
npm run cli -- replay --artifact <path> --param memberId=99999        # -> PERMISSION_DENIED

# RECOVERABLE condition — dismissed automatically, run still succeeds:
npm run cli -- replay --artifact <path> --param memberId=12345 --inject maintenance_interstitial

# HARD FAILURE — stops with a debuggable error + screenshot + DOM snapshot:
npm run cli -- replay --artifact <path> --param memberId=12345 --inject app_error

# INPUT validation failure — fails fast, before touching the browser:
npm run cli -- replay --artifact <path> --param memberId=not-a-number
```

`--inject` values: `slow`, `session_timeout`, `maintenance_interstitial`,
`app_error`, `deny_all_members` (arms the mock app's control channel).

### 5. Human escalation / live-session handoff

If the agent gets stuck, or replay hits a condition it can't recover from, or an
irreversible step needs sign-off, the system pauses and prints:

```
⚠  ESCALATION — human control required. Operator console: http://localhost:4600/
```

Open that URL. The **headed Chromium window stays open** — you operate it
directly, finish the manual step, type a note, and click **Resume automation**.
Your actions are captured into the run record. Run headed (omit `--headless`) to
see this.

For unattended / CI runs, pass `--auto-resume-file runs/resume.json` and a human
"resumes" by writing `{"done":true,"notes":"..."}` to that file.

To force an escalation for the demo, run a discovery goal that requires an
irreversible confirm, e.g.:

```bash
npm run cli -- discover \
  --goal "open a new Regular Savings sub-account for member 12345 with a \$25 initial deposit and submit it" \
  --param memberId=12345 --param product="Regular Savings" --param initialDeposit=25
```

The agent reaches the review screen; the **Submit Sub-Account** click is
classified irreversible and routed to the operator console for approval.

### 6. Capability catalog (stretch goal)

```bash
npm run cli -- catalog list                       # typed tool defs for every saved artifact
npm run cli -- catalog approve meridian-core.member.read_savings_balance --version 1.0.0
npm run cli -- catalog serve --port 4700 &
curl -s localhost:4700/capabilities | jq
curl -s -XPOST localhost:4700/capabilities/meridian-core.member.read_savings_balance/invoke \
  -H 'content-type: application/json' -d '{"args":{"memberId":"12345"}}' | jq
```

---

## Running without live services

* `npm test` — full replay + error-taxonomy coverage against the mock app, no API key.
* `npm run cli -- replay ...` — needs only the mock app running (`npm run mock`).
* `npm run cli -- discover ...` — the only command that needs `ANTHROPIC_API_KEY`.

## Repo layout

```
src/
  mock-app/      the legacy target (stand-in for a real bank system)
  surface/       Surface interface + web (Playwright) implementation
  agent/         discovery loop, tools, prompt, RunTrace
  artifact/      schema (Zod), synthesis (trace->artifact), filesystem store
  replay/        deterministic engine + result contract
  safety/        allowlist/guard + redaction
  escalation/    handoff server + escalation coordinator
  catalog/       agent-facing capability catalog + HTTP server
  observability/ per-run event log + evidence
test/            unit tests + end-to-end replay tests
evidence/        committed logs + artifact from real runs
```
