# BackfillGuard

**Safe Concurrent Healthcare Data Backfill** — a synthetic simulation of how to backfill a derived field
across a large patient dataset while clinical staff keep editing the same records, survive a crash that
destroys the job's checkpoint, and then *prove* that nothing newer was overwritten.

<a id="healthcare-disclaimer"></a>
> ### ⚠ Healthcare disclaimer
>
> Every patient record in this project is **randomly generated**. The "Patient Risk Score" is an **invented
> formula** built to demonstrate data-migration safety. It has **no clinical meaning**, it is **not** a
> clinical decision-support system, and it must **never** be used for any medical purpose. No real or
> re-identifiable patient information is present anywhere in this repository. No claim of clinical validity is
> made anywhere in this codebase or its documentation.

---

## Contents

1. [The problem](#1-the-problem)
2. [The solution](#2-the-solution)
3. [Architecture](#3-architecture)
4. [Technology stack](#4-technology-stack)
5. [Data model](#5-data-model)
6. [The backfill algorithm](#6-the-backfill-algorithm)
7. [The version-control mechanism](#7-the-version-control-mechanism)
8. [Recovery strategy](#8-recovery-strategy)
9. [Verification guarantees](#9-verification-guarantees)
10. [Running the demo](#10-running-the-demo)
11. [Testing](#11-testing)
12. [Limitations and what is simulated](#12-limitations-and-what-is-simulated)
13. [Healthcare disclaimer](#healthcare-disclaimer)

---

## 1. The problem

A hospital adds a computed risk score to every patient record. There are a million of them, so the backfill
takes hours. The system cannot be taken offline — doctors, nurses and laboratories are filing new readings
throughout.

That produces a window in which a computed result is already wrong:

```
t0   backfill reads P0042 at version 2  (glucose 118)   → computes score 48
t1   a lab files a new glucose reading   118 → 210       version 2 → 3
t2   backfill writes score 48
```

At `t2` the score describes data that no longer exists. And a backfill built the usual way — load the entity,
mutate it, save it — writes the **whole row** back from its in-memory copy, reverting glucose to 118. The lab
result is gone from the chart.

The reason this is hard to catch: the engine then rescores from the reverted value, so the row ends
**internally consistent**. Its score matches its data. Both are wrong. A consistency check passes.

---

## 2. The solution

> **The guarantee:** every eligible patient record is eventually considered, while no newer legitimate online
> update is overwritten by stale backfill data.

Four mechanisms, each addressing one half of that sentence:

**A version predicate that travels with the write.** Derived fields are persisted by exactly one method, and
it cannot be called without the version the computation was based on:

```sql
UPDATE Patient SET riskScore = ?, riskLevel = ?, lastBackfillVersion = ?
 WHERE id = ? AND version = ?
```

Zero rows matched is *authoritative* evidence that the row moved — not a hint from a separate re-read. And the
`SET` clause contains no clinical field, so a backfill write is **structurally incapable** of losing a
clinical update.

**Re-evaluation, never retry-with-the-old-value.** A refused write means the value is stale, so the only
correct response is to re-read, recompute and write under a fresh guard. There is deliberately no code path
that writes the original value after a rejection — that path is exactly the bug being demonstrated. Records
that stay contended past the retry limit end as `FAILED` and are reported, because an unresolved record is an
honest gap and a stale write is a silent violation.

**Recovery from data, not from a cursor.** Resume position is derived by asking the database which records
already carry a score computed from the version they currently hold. Checkpoints exist and are useful, but
correctness does not depend on them — which the demo proves by destroying them before recovering.

**An independent audit.** A separate engine re-reads the database and the ledgers and recomputes every number.
It receives no counter from the backfill. Six checks, each reported with the method it used.

**And a counter-example.** A deliberately unsafe naive engine runs the same scenario on the same data and
fails, which is how the safety mechanism is shown to be load-bearing rather than decorative. A control run
with no contention has both engines agree exactly — because the naive engine is not broken in general, only
when something changes underneath it.

---

## 3. Architecture

```
frontend/   React 19 · Vite · Tailwind 4        Dashboard · Patients · Comparison · Report
   │                                            components = presentational, hooks = all data access
   │ HTTP + Socket.IO
backend/src/api/       Express 5 routers, zod schemas, error envelope, request logging
backend/src/domain/    The simulation. Imports no Prisma, no Express, no Socket.IO.
backend/src/infra/     Adapters: Prisma repositories, Socket.IO transport, seeding
shared/                Types, enums, bounds, job transition table — imported by both sides
```

The simulation core depends only on injected ports (`PatientRepository`, `JobRepository`, `EventSink`), so the
same engines run against SQLite in the application and against in-memory stores in tests and in the naive
comparison. Both repository adapters are held to **one shared contract test suite**, because if their
semantics drift then every conclusion the tests reach about safety stops applying to the running system.

Everything is dispatched from a **single tick loop**. Nothing else in the domain owns a timer, and a guard test
fails the build if `setTimeout`, `Math.random()` or `new Date()` appear anywhere in `src/domain`. That is what
makes the run reproducible: with two independent timers the interleaving would depend on event-loop
scheduling, so the set of conflicting records would differ between machines.

→ **[docs/architecture.md](docs/architecture.md)** — layers, ports and adapters, event flow, restart
behaviour, and why `version` means source-data version.

---

## 4. Technology stack

| Layer | Choice | Version |
|---|---|---|
| Language | TypeScript | 7.0.2 |
| Runtime | Node.js | ≥ 22.12 |
| API | Express | 5.2.1 |
| Validation | Zod | 4.5.4 |
| Database | SQLite via Prisma | 6.19.3 |
| Live transport | Socket.IO | 4.8.3 |
| UI | React | 19.2.8 |
| Build | Vite | 8.2.2 |
| Styling | Tailwind CSS (CSS-first, no JS config) | 4.3.3 |
| Icons | lucide-react | 1.41.0 |
| Tests | Vitest · React Testing Library · supertest | 5.0.0 · 16.3.3 · 7.2.2 |

No charting library: every quantity on screen is a real count, and a bar chart of six numbers would add a
dependency without adding information. No PDF library either — report export is `window.print()` plus a print
stylesheet, which produces a correct PDF through the browser's own dialogue with no second rendering path to
keep in step.

---

## 5. Data model

Nine tables. The design work is in what is stored *separately*.

`Patient` splits into three blocks, and which code may write which block is the crux of the whole design:

| Block | Fields | Writable by |
|---|---|---|
| Identity | `patientCode`, `name`, `age`, `partitionIndex` | seeding only |
| **Clinical source** | `bloodPressureSystolic`, `bloodPressureDiastolic`, `heartRate`, `glucose`, `diagnosis` | **online updates only** |
| **Derived** | `riskScore`, `riskLevel`, `backfillStatus`, `lastBackfillVersion` | **backfill engines only** |
| Version | `version` | **online updates only** |

Four tables exist purely so correctness can be *audited* rather than asserted:

| Table | Purpose |
|---|---|
| `ConsiderationLedger` | One row per record per job, uniquely keyed. The coverage proof — a set comparison, not a counter. |
| `WriteLedger` | One row per write *attempt*, applied or not, with the guard version and the row's true version read in the same transaction. |
| `Conflict` | A detected collision: both versions, the field diff, the refused score, the applied score, the resolution. |
| `PendingResult` | Computed-but-unwritten results, staged **durably** — this is what carries staleness across a crash. |

Plus `BackfillJob`, `Checkpoint`, `OnlineUpdate` and `EventLog`.

The consideration ledger's uniqueness constraint is load-bearing: recovery legitimately revisits records, and a
second row would inflate coverage and could let a job claim 100% while having genuinely missed something. So
re-deciding a record upserts.

---

## 6. The backfill algorithm

Per record, per partition:

```
read     → sourceVersion, clinical snapshot
compute  → pure function, no I/O, no clock, no randomness
stage    → append to the in-flight batch
flush    → guarded write per staged entry
```

Reading, computing and writing are separate phases on purpose. The gap between staging and flushing is the
in-flight window — the only interval in which an online update can make a result stale — and it is what the
whole demonstration is about.

On a refused write: record the conflict *before* attempting anything else (so a crash midway leaves durable
evidence), then re-read, recompute and write under a fresh guard, looping with a bounded attempt limit. Each
attempt reads the version it will guard against, so a retry is a new computation from newer data rather than a
blind repeat.

Completion is **refused**, not assumed:

```
missing = all patient ids − consideration ledger for this job
if missing is not empty → FAIL the job, naming the records
```

The job physically cannot report success while a record is unaccounted for.

→ **[docs/backfill-algorithm.md](docs/backfill-algorithm.md)** — full pseudocode, the guarded write, the
re-evaluation loop, recovery boundary derivation, and what each verification check would catch.

---

## 7. The version-control mechanism

`version` is the **source-data version**. It is incremented exclusively by online updates; backfill engines
never touch it.

The obvious alternative is a row version — bump it on every write, including the backfill's. That is what most
optimistic-concurrency examples do, and it would still prevent lost updates. It was rejected because it
destroys the project's best piece of evidence.

Under the source-data model, `lastBackfillVersion == version` is a **meaningful, independently checkable
statement**: *this record's score was derived from the clinical data it currently holds*. Anyone can check it
with one query, with no ledger and no trust in any counter:

```sql
SELECT COUNT(*) FROM Patient WHERE lastBackfillVersion < version;
```

Under a row-version model the backfill's own write would bump `version`, so the two would always be equal
immediately after a write regardless of whether the data underneath had changed. The comparison would be a
tautology, verification would have to fall back entirely to the write ledger, and the per-patient
`v4 / v2` display — the most informative column in the patient table — could not exist.

The patient table shows the pair as one cell for exactly that reason: the comparison is what the eye should do
first.

---

## 8. Recovery strategy

Recovery **never consults a checkpoint**. Whether one survives is irrelevant to correctness, which is the claim
the demo makes by destroying it first.

```
for each partition, ascending:
  settled = every record has lastBackfillVersion == version AND riskScore IS NOT NULL
  if not settled → resume here
```

Then, from that boundary to the end of the dataset, every record is revisited. A record found already derived
from its current version is recorded as `NO_ACTION_ALREADY_CURRENT` and **left untouched** — the single best
piece of evidence that recovery reasoned about the data rather than blindly rewriting it. The recovery summary
separates no-ops from reprocessed records for that reason.

Staged results from the crash are revalidated against the current version *before* any write. Still current →
flushed. Moved during the outage → rejected and recomputed.

**The boundary can move backwards, and that is intended.** If a clinician edited a record in partition 0 while
the job was working in partition 3, partition 0 is no longer settled — its score is now older than its data —
so recovery goes back for it. A cursor-based resume would have skipped it permanently. This is the strongest
argument for evidence-based recovery: it is not merely a way to survive losing a cursor, it is *more correct*
than a cursor.

---

## 9. Verification guarantees

An independent engine takes repositories only — no engine instance, no counters, no in-memory state — and
derives every number by re-reading persisted rows and recomputing.

| Check | What it verifies | What it would catch |
|---|---|---|
| **C1** Coverage | Set difference: all patient ids vs the consideration ledger | A silently skipped record — an off-by-one, a `continue` that forgot to record, a batch dropped on an error path |
| **C2** No stale overwrite | No applied write had `guardVersion < rowVersionAtWrite` | The headline failure: a write that landed carrying older data |
| **C3** No lost online update | Every `OnlineUpdate` replayed field by field against current values | The naive engine's actual failure — **the only check that catches it** |
| **C4** Derived consistency | Recompute every score from current values and compare | A stored score that does not follow from its own data, *even if every counter said zero* |
| **C5** Valid outputs | Score present, in range, band label matches score | A null score on a completed record, or a level written from a different computation than the score |
| **C6** Conflicts resolved | No conflict left `PENDING`, no record left `PROTECTED` | A conflict recorded and then abandoned |

**Why C3 matters most.** C4 *passes* for a naive run: the engine reverts the clinical value and then rescores
from the reverted value, so the row is internally consistent — score and data agree, and both are wrong.
Without C3 the comparison would report `inconsistentRecords = 0` on both sides and prove nothing.

**Falsifiability.** A check that cannot fail proves nothing, so each has a companion test that deliberately
breaks the invariant — deletes a ledger row, injects an unguarded write, reverts a clinical value, corrupts a
score, mislabels a level, leaves a conflict pending — and asserts the verdict flips to `VERIFICATION_FAILED`.
"Stale overwrites = 0" is only meaningful because a non-zero is reachable.

There is deliberately no clamping, flooring or defaulting anywhere in the verification engine. And nothing on
the dashboard defaults a missing value to zero: an unmeasured metric renders as "—" with a reason, because
"0 stale overwrites" shown before any audit is a claim we cannot support that happens to match the eventual
answer.

**Post-consideration drift is reported, not hidden.** A record updated *after* it was correctly considered has
`lastBackfillVersion < version`. That is not a violation — the record was considered and nothing stale was
written over it; the score is simply older than the newest reading. It is counted separately and explained in
words rather than flagged as a fault.

---

## 10. Running the demo

Requires **Node.js 22.12 or newer**. No `.env` file needed and no secrets anywhere — the database path is
resolved to an absolute location in code, so the Prisma CLI and the running app cannot disagree about which
file they are using.

```bash
npm install          # also generates the Prisma client
npm run db:migrate   # create the SQLite schema
npm run db:seed      # generate 1,000 synthetic patients
npm run dev
```

- Frontend — **http://localhost:5173**
- Backend health — http://localhost:4000/api/health

Then press **RUN DEMO**, above the fold on the dashboard. It takes **about 19 seconds** and runs the
whole argument: start, two in-flight collisions, a crash mid-batch, a clinical update during the outage,
checkpoint destruction, evidence-based recovery, and the independent audit.

**Measured:** 18.9s, 18.9s and 18.7s on three consecutive runs of the default 1,000-record dataset. All three
produced the identical eleven-patient conflict set — the dataset is regenerated from the seed and every random
stream is reset at the start of a run, so a repeat is a genuine replay rather than a fresh run with the same
settings.

Everything is also driveable by hand: start, pause, resume, crash, destroy the checkpoint, recover, trigger a
doctor / nurse / lab update, verify, reset, reseed. Controls that are unavailable say **why**, using the same
state-machine table the server enforces — so the interface never offers something the server would refuse.

→ **[docs/demo-script.md](docs/demo-script.md)** — timed narration a presenter can follow verbatim, in
three-minute and six-minute versions, plus a troubleshooting table.

### All commands

| Command | Purpose |
|---|---|
| `npm run dev` | Backend and frontend together |
| `npm run dev:backend` / `dev:frontend` | One side only |
| `npm test` | Full suite, non-watch, both workspaces |
| `npm run test:backend` / `test:frontend` | One workspace |
| `npm run typecheck` | Typecheck every workspace |
| `npm run build` | Typecheck backend, build the frontend bundle |
| `npm run db:migrate` | Apply the schema |
| `npm run db:seed` | Regenerate the synthetic dataset from a seed |
| `npm run db:reset` | Clear job state and unscore patients, keeping the same dataset |

`db:seed` regenerates patients; `db:reset` keeps them and returns every record to an unscored baseline. See
[`.env.example`](.env.example) for the tunable settings and their bounds — every bound is enforced
server-side, independently of the client.

---

## 11. Testing

```bash
npm test          # 506 tests, non-watch: 396 backend + 110 frontend
npm run typecheck # all three workspaces
```

The suite is structured around what could actually go wrong rather than around code coverage:

- **The twelve required scenarios** — safe update, conflict detected, stale result rejected, re-evaluation,
  version increment, checkpoint creation, checkpoint loss forcing evidence-based recovery, recovery not
  blindly overwriting, every record considered, zero stale overwrites, naive engine demonstrating a stale
  overwrite, guarded engine preventing the same one.
- **Falsifiability tests** for all six verification checks — each deliberately breaks an invariant and asserts
  the verdict flips.
- **One contract suite run against both repository adapters**, so SQLite and in-memory cannot drift.
- **A headless scripted-demo suite** asserting all six demo guarantees at two dataset sizes, including the
  smallest the bounds permit — an earlier version of the script used absolute record counts, which worked at
  1,000 records and silently skipped the crash entirely at 100.
- **Determinism tests** covering both fresh-process and *repeated-in-one-process* replay. The second is the
  one that was actually broken: four consecutive live runs reported 6, 8, 7 and 7 conflicts before the RNG and
  the dataset were reset per run.
- **41 API tests** over HTTP, asserting that `riskScore`, `riskLevel`, `version`, `lastBackfillVersion` and
  `age` are *rejected* rather than merely ineffective — a schema that stripped them would pass an
  effect-based test while advertising a surface that is not there.
- **Two source-level guard tests.** One fails the build if `Math.random()`, `Date.now()`, `new Date()`,
  `setTimeout` or `setInterval` appear in `src/domain`. The other fails it if any *test* file uses
  `setTimeout` or `await new Promise(...)` to synchronise — a test that sleeps to let things settle passes on
  a fast machine and fails intermittently on a slow one.
- **A repository-hygiene test** asserting no `.env`, database file, generated client, native binary,
  credential-shaped string or absolute local user path is ever tracked.

---

## 12. Limitations and what is simulated

Stated plainly, because a demo that blurs this line is not worth trusting.

### Simulated

| Simulated | What a real system would have |
|---|---|
| The 1,000-record patient dataset | A real EHR table |
| The "Patient Risk Score" formula | A clinically validated model |
| Clinical staff editing records | Actual concurrent traffic from hospital applications |
| The crash (a button) | A pod eviction, OOM kill, deploy, network partition |
| Checkpoint destruction (a button) | A lost volume, a corrupted cursor, a truncated table |
| Wall-clock pacing (`backfillSpeed`) | Whatever throughput the database sustains |

The simulation is also **biased toward contention**: automatic updates preferentially target records currently
in flight, because that is the only window in which the guard can be exercised. Under uniform random targeting
the same mechanism behaves identically — conflicts are simply rarer. The bias is documented at the point it is
introduced.

### Real engineering

The version-guarded write, the compute-then-write pipeline with a durable staging table, the evidence-based
recovery boundary, the consideration ledger as a coverage proof, bounded re-evaluation with a real failure
outcome, and the independent audit reading persisted state. These would transfer unchanged.

### Deliberate omissions

- **No authentication or authorization.** Single-user demo; there is no user model at all.
- **No multi-process coordination.** One orchestrator owns the job. A real deployment would need leader
  election or a work-queue claim protocol; the per-record guarded write would be unchanged.
- **No migration versioning for the derived field.** A second backfill generation would need to distinguish
  "scored by formula v1" from "scored by v2". `RISK_CONFIG_VERSION` is stored alongside computed scores so the
  information exists, but nothing consumes it yet.
- **SQLite, single writer.** The version predicate is identical under Postgres, but the transaction-isolation
  characteristics are not and would want re-testing.
- **No rate limiting** beyond a bounded request body size and a per-socket resync throttle.
- **Three npm advisories remain**, all in `deepmerge-ts` reached through `@prisma/config` — a Prisma **CLI**
  devDependency, absent from the runtime client and from any shipped bundle. npm's suggested fix downgrades the
  Prisma CLI to a version that no longer matches the generated client, which would break the build. Accepted
  and documented rather than silently patched.

---

## Specification

The full specification lives in [`.kiro/specs/backfillguard/`](.kiro/specs/backfillguard/):
[requirements](.kiro/specs/backfillguard/requirements.md) ·
[design](.kiro/specs/backfillguard/design.md) ·
[tasks](.kiro/specs/backfillguard/tasks.md)

---

## Repository layout

```
shared/     Types, enums, simulation bounds, job transition table (single source of truth)
backend/    Express API + simulation domain (engines, recovery, verification, scenario)
frontend/   React dashboard, patient browser, comparison, verification report
docs/       architecture.md · backfill-algorithm.md · demo-script.md
.kiro/      Requirements, design and task specification
```
