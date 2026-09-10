# Design write-up

## 1. Architecture

The system is one Node/TypeScript process with five boundaries that matter, each
depending only on the ones below it:

```
 CLI  /  catalog HTTP endpoint            ← how an agent or operator invokes it
   │
 discovery loop (LLM)   replay engine (no LLM)      ← the two execution paths
   │        │                 │
   └────────┴──── artifact schema + synthesis ──────┘   ← the shared contract
                        │
   Surface interface  ──┴──  safety guard · redaction · escalation   ← cross-cutting
                        │
   PlaywrightSurface (web)         ← the one concrete surface implemented
```

**Key decisions & trade-offs**

* **One process, filesystem storage, synchronous execution.** The brief
  explicitly does not reward queues/clusters/multi-tenant plumbing. Artifacts are
  `artifacts/<id>/<version>.json`; runs are directories under `runs/`. The
  access pattern (write-once artifact revisions, read-many; append-only run
  logs) maps cleanly onto object storage + a metadata table later without
  touching the core.
* **The `Surface` interface is the load-bearing abstraction.** The agent loop,
  the replay engine and the artifact never import Playwright, never see a DOM,
  never see coordinates. They speak `observe()`, `resolve(TargetSelector)`,
  `click/fill/select/press`, `evaluate(Check)`. A legacy-web or desktop surface
  is a new implementation of the same interface (§4).
* **Discovery produces a `RunTrace`, not a transcript.** The trace is a typed
  list of `(observation → decision → action → outcome)`. A **deterministic
  compiler** (`synthesize.ts`) turns it into an artifact. The model is not in the
  synthesis path, so the artifact is reproducible from the trace and reviewable
  independently of the chat.
* **Perception is accessibility-first.** Each observation is: the page's ARIA
  snapshot, a list of *interactable* elements (role, accessible name, associated
  label, frame) and a list of *readable* elements (table cells / values — the
  data goals actually ask for), plus a visible-text digest and a screenshot.
  Raw CSS paths are collected but only ever used as low-confidence fallbacks.
  This is deliberately the information a screenshot-or-a11y-only surface could
  also produce.
* **LLM = Claude Sonnet, driven through a hand-rolled tool-use loop** rather than
  a framework, so every tool call passes through the guard and the run log before
  it reaches the surface. One action per turn, then re-observe — this keeps the
  trace clean and each step individually checkpointable.
* **Target app is a local mock**, not a public site. It lets the demo mirror the
  brief's own examples ("look up member 12345…", "open a sub-account…") and, more
  importantly, lets replay's error handling be demonstrated deterministically via
  an injection control channel. It is intentionally hostile: nested tables, no
  test IDs, an iframe, `<input type=submit>` buttons, cookie sessions.

## 2. Artifact schema

`src/artifact/schema.ts`. A `CapabilityArtifact` is designed as a **contract an
agent can call and a human can review**, not a macro. Shape and rationale:

* **Identity & versioning** — stable `id` (`meridian-core.member.read_savings_balance`),
  semver `version` per revision, `title`, `description` written for both a human
  and a calling agent, `labels`.
* **`binding`** — `surface`, `vendorProduct`, `appVersionRange`, `tenantId`
  (`null` ⇒ vendor-generic base), `baseCapabilityRef` (this artifact specialises
  another), and a templated `entryPoint`. This is the seam for multi-tenant reuse
  (§4).
* **`parameters`** — typed inputs the agent supplies per call: `type`, `required`,
  `pattern`/`enumValues` for validation, `example`, and **`sensitivity`**
  (`none|pii|secret`) which drives redaction. Replay validates against this
  before touching the browser.
* **`outputs`** — typed return shape (`string|number|money|boolean|date`),
  `sensitivity`, and `producedByStep`. The extraction detail (attribute,
  transform, regex) lives on that step's `extract` action.
* **`preconditions`** and **`successCondition`** — `Check`s asserted before step 1
  and after the last step. Success is *asserted*, never assumed.
* **`steps[]`** — each has an `intent` (plain-language, for review), a typed
  `action` (discriminated union: navigate/click/type/select/press/
  acknowledgeDialog/extract), an optional `target`, `waitFor` readiness `Check`s,
  a `postCondition` checkpoint, step-scoped `onError` handlers, a `timeoutMs`, an
  `optional` flag, and a `riskClass`.
* **`TargetSelector`** — the robustness story. A `description`, a `frame`
  reference, and an **ordered list of `LocatorStrategy`**, each carrying
  `kind` (role / label / placeholder / text / nearText / testId / css / xpath),
  its fields, a **`rationale`** string, a **`confidence`** 0–1, and a `brittle`
  flag. Replay tries them in order and records which one won. A reviewer can read
  the rationale and confidence and judge durability without re-running anything.
* **`errorHandlers[]`** — the error taxonomy travels *in the artifact*. Each is
  `{ when: ErrorSignal, classify: business_outcome | recoverable | hard_failure,
  outcomeCode?, recovery?, message? }`. Capability-level handlers apply to every
  step; step-level ones take precedence.
* **`policy`** — allowed action kinds, allowed URL regexes, `riskLevel`,
  `requiresApprovalToRun`, and `confirmationRequiredForSteps`.
* **`provenance`** — `createdAt`, `model`, `discoveryRunId`, `sourceGoal`, and
  **`redactions`** (a list of *what* was scrubbed — field names / categories —
  never values).
* **`approval`** (`draft|approved|deprecated`) and **`stability`**
  (`replays`/`successes`/`lastVerifiedAt`, updated by the replay path).

Why this shape: the three things that break record-once/replay-many in practice
are (a) locators, (b) unhandled runtime states, and (c) treating a business
answer as a crash. The schema forces an explicit answer to all three at record
time — ordered locator strategies with rationale, a per-condition classification,
and `outcomeCode`s that are first-class results.

## 3. Determinism & error handling

**Determinism**

* Replay never calls the model. Given the same artifact + params it issues the
  same actions in the same order.
* **No fixed sleeps.** Every wait is a poll of an explicit `Check`
  (`waitFor` before acting, `postCondition` after) with a timeout. The only
  `setTimeout` is recovery back-off.
* **Locators are strategy lists resolved deterministically**: first strategy that
  resolves to ≥1 element wins; >1 match without a `disambiguation` rule takes
  `.first()` and records the ambiguity. The winning strategy and match count go
  into the run log, so locator drift shows up as "strategy 0 failed, strategy 2
  matched" rather than a hard break.
* Parameter values are templated (`{{memberId}}`, `{{baseUrl}}`) into URLs,
  locator names and typed text at run time.

**Runtime error handling** — after every step (and after the entry navigation)
the engine scans the artifact's error handlers and classifies what it sees:

| Class | Meaning | Engine behaviour | Example |
|---|---|---|---|
| **business_outcome** | a legitimate answer the caller needs | stop, return `{status:"business_outcome", outcomeCode, message, atStep}` | `MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_REJECTED` |
| **recoverable** | transient / known interstitial | run the `recovery` action, retry the step (bounded: 2×/step), append to `result.recovered[]` | dismiss maintenance notice, `reAuthenticate` on session timeout, wait/retry a slow load |
| **hard_failure** | unexpected, unsafe to proceed | stop, capture screenshot + DOM snapshot, return `{status:"failure", failureKind, atStep, expected, observed, message}` | app 5xx, "an unexpected error occurred" |

Signals are matched on: visible text (optionally in a named frame), URL regex,
**HTTP status** (a response listener keeps the last ~25 document statuses),
element visibility, or "the expected checkpoint never came true"
(`checkpointTimeout`). Input-validation failures are caught *before* the browser
starts and returned as `failureKind:"input"`. Guard denials are
`failureKind:"guard"`. The result contract is a discriminated union so a calling
agent branches on `status` and never has to parse a message.

**UI drift** (secondary, per the brief): handled by the ordered locator
strategies + confidence, and surfaced in logs; `stability` counters make a
capability that has started failing visible. A real deployment would alert when
`successes/replays` drops or when replay consistently falls through to a
low-confidence strategy.

## 4. Heterogeneity & multi-tenant

**Surface abstraction → legacy web & desktop.** The seam is `Surface`. The
artifact only ever references a `TargetSelector` (ordered strategies + a
`FrameRef`) and a `Check`; it has no DOM concepts baked in. To add a surface you
implement `observe()`, `resolve()`, the action primitives and `evaluate()`:

* *Legacy web (framesets, nested tables, no IDs):* same Playwright implementation;
  `FrameRef` already addresses frames by name/url/index, and the `nearText` /
  `role` / row-anchored-`css` strategies are exactly what you fall back to when
  there are no test IDs. The perception layer already emits table-cell
  "readables" with row context for this reason.
* *Desktop (Win32/UIA, Electron):* a `UiaSurface` maps `role`+`name` strategies
  onto the UI Automation tree (which exposes `ControlType` + `Name`), `nearText`
  onto sibling traversal, screenshots onto the OS grab. `css`/`xpath` strategies
  simply don't apply on that surface and are skipped — the strategy list
  degrades rather than breaks. Perception becomes accessibility-tree +
  screenshot, which is already the model's diet.

The recorded *flow* (intent, ordering, checkpoints, error taxonomy, parameters,
outputs) is surface-independent; only the strategy *kinds* that resolve differ.

**Multi-tenant reuse.** Hundreds of tenants, ~20 apps each, many on the same
vendor product. The model:

* An artifact's `binding` carries `vendorProduct` + `appVersionRange` and
  `tenantId: null` for a **base capability** — recorded once against a reference
  instance of the vendor app.
* A tenant that differs gets a thin **specialization**: a new artifact with
  `tenantId` set and `baseCapabilityRef` pointing at the base. Only the deltas
  are stored — an overridden `entryPoint`, an extra `errorHandler` for a
  tenant-specific interstitial, or a replaced `TargetSelector` for a step whose
  control was rebranded. Resolution = base ⊕ overrides. No re-recording.
* **Drift detection:** each replay records the winning locator strategy index and
  confidence per step, plus checkpoint pass/fail, into `stability`. A scheduled
  "canary replay" per (tenant, capability) turns that into a signal: fell through
  to a brittle strategy, checkpoint latency rose, or a new unclassified error
  page appeared ⇒ open a review task and (optionally) auto-draft an override from
  the canary's trace. Version pinning (`appVersionRange`) plus a cheap
  fingerprint of the login/landing page lets the platform notice a tenant was
  upgraded and re-validate before trusting unattended replay.

**Canonicalization** (stretch, designed not fully built): `synthesize.ts`
already templatizes concrete values into `{{param}}`; the same pass would
normalize `/members/12345` → `/members/:id` route patterns so a base artifact's
`allowedUrlPatterns` and `entryPoint` generalize across tenants.

## 5. Escalation & handoff

**Detecting "stuck".** Discovery: the agent calls the `escalate` tool, or hits
the consecutive-error cap, or the guard returns `confirm` on an irreversible
action. Replay: a `recoverable` handler with `recovery: escalate`, a
`reAuthenticate` with no re-auth hook, a `confirmationRequiredForSteps` step, or
recovery exhaustion.

**Routing with context.** `escalate()` (shared by both paths) captures a
screenshot + DOM snapshot, then raises an intervention carrying: origin
(discovery/replay), capability/goal, the exact step, current URL, visible text at
the stop point, and the question for the operator. It's written to the run log
and shown on the operator console.

**Taking control of the *same* live session.** `Surface.cedeControl()` starts a
handoff against the **same Playwright `BrowserContext`/`Page`** the automation was
using — the headed Chromium window simply stays open and the human drives it.
The console (a minimal Express page, port 4600) shows the context and a **Resume**
button. Human actions in the live page (clicks, field changes with password
values masked, form submits, navigations) are captured via an exposed binding +
init script and land in the run record. Automation is blocked on
`waitForResume()` until the operator clicks Resume (or, unattended, a resume file
appears); it then **re-observes the now-changed page** and continues from the
next step.

**The seam.** Control is a token: automation holds it, `cedeControl()` transfers
it to the operator, `waitForResume()` transfers it back. Evidence
(screenshots, logs, the trace) is continuous across the boundary and the human's
actions are recorded as a distinct step. What's mocked: the operator console is
deliberately minimal (no video co-browsing, no remote input relay — explicitly
out of scope). The control-transfer model and the "same live session" guarantee
are real.

## 6. Safety

**Allowlist (enforced on every action, both paths).** `Guard.check()` runs before
navigate and before every click/type/select. It refuses (a) action kinds not in
`policy.allowedActionKinds`, (b) URLs not matching `policy.allowedUrlPatterns`
∩ the run-level allowlist. Replay also refuses an `entryPoint` outside the
allowlist.

**Risky vs. reversible.** Every action is classified `read_only` / `reversible` /
`irreversible` from its kind + a keyword rule over the target description
("submit sub-account", "confirm", "transfer", "post", "wire", "delete" ⇒
irreversible). Irreversible actions are **not executed autonomously**: in
discovery they route to the operator console for approval; in replay they are
blocked unless the artifact is `approved` **and** the step isn't in
`confirmationRequiredForSteps`. Choice: *confirm*, not hard-*block*, because a
bank genuinely needs "open the sub-account" to run — but only behind an approval
gate and a human-reviewed artifact. `--risky block` is available for a stricter
posture.

**Data handling.** A `Redactor` scrubs (1) registered exact secret values
(password params, typed `secret` fields) and (2) well-known shapes (API keys,
bearer tokens, SSN, card numbers, emails) from **every** log line, observation
dump, artifact and evidence file — redaction happens in the `Run` writer, so
nothing bypasses it. Artifacts store `provenance.redactions` = the *categories*
scrubbed, never the values. Params marked `pii`/`secret` are redacted out of
outputs too.

**Limits.** Keyword-based risk classification is heuristic — a mis-labelled
button could be under-classified; the mitigation is that irreversible-by-URL and
the approval gate are independent layers. Redaction is best-effort pattern
matching; a novel PII format in free text could slip through. The allowlist is
per-run config, not cryptographically enforced — a compromised artifact can't
escape it, but a compromised *runner* could. Prompt-injection from page content
into the discovery agent is only partially mitigated (guard + allowlist + one
action/turn + human approval for writes); a hardened version would also
constrain the agent's tool arguments against the observed DOM.

## 7. Cuts

**Deliberately not built (seams are real):**

* **Operator console is minimal** — context + captured actions + a Resume button,
  driving the already-open headed browser. No video co-browsing / remote input
  relay (explicitly out of scope).
* **One surface implemented** (web/Playwright). `Surface` is the seam;
  legacy-web and desktop are designed in §4, not coded.
* **Multi-tenant override resolution** — the `binding` fields
  (`tenantId`, `baseCapabilityRef`) exist and are documented; base⊕override
  merging and canary drift detection are designed, not implemented.
* **`annotate` pass** — synthesis is fully deterministic; an optional LLM pass to
  improve human-readable descriptions is stubbed behind a flag.
* **Assisted fallback / confidence scoring / multi-run stability** — `stability`
  counters are wired; the analytics on top are next, not now.
* **Persistence beyond the filesystem**, auth beyond a scripted mock login, and
  any queueing.

**What I'd build next, in order:**

1. Base⊕override artifact resolution + a `canary-replay` command that records
   drift signals per (tenant, capability).
2. A `UiaSurface` (desktop) to prove the seam against a genuinely different
   perception/action model.
3. Bounded, policy-checked single-step LLM recovery on replay failure, recorded
   as evidence (stretch "assisted fallback").
4. Harden the discovery agent against prompt injection: validate every tool
   argument against the current observation before it reaches the guard.
