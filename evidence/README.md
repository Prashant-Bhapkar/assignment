# Evidence index

All runs below are real: a genuine Claude Sonnet 5 discovery run driving a live
headless Chromium against the mock "Meridian Core" app (`npm run mock`), and
seven deterministic replay runs of the artifact it produced — **no LLM calls
during replay**. Each directory has `events.jsonl` (structured log, PII/secrets
redacted), screenshots, DOM/observation snapshots, and a `result.json`.

## Discovery run

**`discovery-2026-09-13_06-29-52/`** — goal: *"look up member 12345 and read
their current savings balance"*.

The agent (`transcript.json` has the full tool-use transcript; `trace.json` the
distilled record) navigated Dashboard → Member Search → typed `12345` → Search →
opened the result → extracted the savings balance from the account-summary
iframe → finished. `artifact.json` is the emitted capability, also saved to
`/artifacts/meridian-core.member.read_savings_balance/1.0.0.json`.

## Replay runs (deterministic, same artifact, no model)

| Run | Params / injection | Result |
|---|---|---|
| `replay-success-2026-09-13_06-30-19/` | `memberId=12345` (the recorded member) | `success`, `savings_balance = 384215` ($3,842.15) |
| `replay-success-2026-09-13_06-30-25/` | `memberId=23456` (**never seen during discovery**) | `success`, `savings_balance = 51002` ($510.02) — proves the capability generalizes, not just replays a fixed member |
| `replay-business_outcome-2026-09-13_06-30-30/` | `memberId=00000` (no such member) | `status: "business_outcome"`, `outcomeCode: "MEMBER_NOT_FOUND"` — **not a crash** |
| `replay-success-2026-09-13_06-30-35/` | `memberId=12345`, `--inject maintenance_interstitial` | `success` after a **recoverable** condition: dismissed the injected "acknowledge to continue" notice mid-run (`recovered[0].handlerId = "maintenance-interstitial"`), then completed normally |
| `replay-failure-2026-09-13_06-30-41/` | `memberId=12345`, `--inject app_error` | `status: "failure"`, `failureKind: "hard"` — the mock app's injected 500 stops the run with a screenshot + DOM snapshot for debugging |
| `replay-failure-2026-09-13_06-30-46/` | `memberId=` (missing) | `status: "failure"`, `failureKind: "input"` — rejected before the browser even opens |

After the runs above, the committed artifact was moved `draft -> approved`
(`npm run cli -- catalog approve ...`) and its `stability` counters
(`replays: 7, successes: 4`) reflect exactly the demo runs on this page — a
live demonstration of the confidence/approval stretch goal (§8), not seed data.

Reproduce any of these:

```bash
npm run mock   # terminal 1
npm run cli -- replay --artifact artifacts/meridian-core.member.read_savings_balance/1.0.0.json --param memberId=23456
```

## A bug this run caught (and why it's left visible)

The first discovery run produced an artifact whose "click the search result"
step targeted the link by its **visible text** ("Dana Whitfield") — correct for
member 12345, but not for any other member, since that text is the record's own
data. Replaying with an unseen `memberId` failed. The fix (see
`src/artifact/synthesize.ts`, "href-based locator" strategy) makes synthesis
prefer a locator built from the link's `href` templated with the parameter
(`a[href="/members/{{memberId}}"]`) over its display text whenever the href
provably encodes the id — which is exactly why `memberId=23456` above now
succeeds. This is left in the evidence trail deliberately: it's the real
failure mode the brief's "locator robustness" requirement is pointing at, not a
hypothetical one.
