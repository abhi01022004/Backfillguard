# Architecture

> All patient data in this project is randomly generated. The risk score is an invented formula with no
> clinical meaning. See the [healthcare disclaimer](../README.md#healthcare-disclaimer).

---

## 1. What is simulated and what is real engineering

This distinction matters more than anything else in this document, so it comes first.

**Simulated — a stand-in for something a real system would have:**

| Simulated | What a real system would have |
|---|---|
| The patient dataset (1,000 generated records) | A real EHR table |
| The "Patient Risk Score" formula | A clinically validated model |
| Clinical staff editing records (doctor / nurse / lab) | Actual concurrent traffic from a hospital's applications |
| The crash (a button that stops the job mid-batch) | A pod eviction, OOM kill, deploy, or network partition |
| Checkpoint destruction (a button) | A lost volume, a corrupted cursor, a truncated table |
| Wall-clock pacing (`backfillSpeed`) | Whatever throughput the database sustains |

**Real engineering — the parts that would transfer unchanged to a production system:**

| Real | Why it is real |
|---|---|
| Optimistic concurrency via a version predicate carried *with* the write | The `UPDATE ... WHERE id = ? AND version = ?` pattern is the actual mechanism |
| The compute-then-write pipeline with a durable staging table | Staged results surviving process death is a genuine durability property |
| Recovery position derived from data rather than a cursor | A real recovery strategy, and the reason checkpoint loss is survivable |
| The consideration ledger as a coverage proof | A set comparison rather than a counter — the same technique auditors ask for |
| Bounded conflict re-evaluation with a failure outcome | Real retry semantics, including the decision never to write a known-stale value |
| Independent verification from persisted state | The audit reads rows and recomputes; it shares no code path with the engine |
| Ports-and-adapters isolation | The same engines run against SQLite and against in-memory stores |

The claim this project makes is about the *mechanism*, not about hospital traffic patterns. The simulation
is biased toward producing contention — `AUTO` mode targets records currently in flight — because that is
the only window in which the guard can be exercised. Under uniform random targeting the same mechanism
behaves identically; conflicts are simply rarer. This is stated plainly in the code where the bias is
introduced (`TARGET_STRATEGY.IN_FLIGHT`).

---

## 2. Layers

```
┌──────────────────────────────────────────────────────────────────┐
│ frontend/            React 19 + Vite + Tailwind 4                │
│   pages/             Dashboard · Patients · Comparison · Report  │
│   components/        Presentational, no data fetching            │
│   hooks/             All data access and the live socket         │
│   api/client.ts      Typed fetch, ApiError envelope              │
└──────────────────────────────────────────────────────────────────┘
                              │ HTTP + Socket.IO
┌──────────────────────────────────────────────────────────────────┐
│ backend/src/api/     Express routers, zod schemas, middleware     │
│                      Validation, error envelope, request logging  │
├──────────────────────────────────────────────────────────────────┤
│ backend/src/domain/  The simulation. Depends only on ports.       │
│   engine/            BackfillEngine · ConflictEngine              │
│                      VersionValidator · CheckpointManager         │
│                      RecoveryEngine · NaiveBackfillEngine         │
│   orchestrator/      SimulationOrchestrator — the single tick loop │
│   online/            OnlineUpdateSimulator (the contention source) │
│   risk/              Pure risk calculator + config-as-data         │
│   verify/            VerificationEngine (the independent audit)    │
│   compare/           ComparisonHarness (naive vs guarded)          │
│   scenario/          DEMO_SCRIPT · ScenarioManager                 │
│   patient/           buildPatientHistory (pure merge)              │
│   ports/             PatientRepository · JobRepository · EventSink  │
├──────────────────────────────────────────────────────────────────┤
│ backend/src/infra/   Adapters. The only code that knows Prisma,    │
│                      Socket.IO or the filesystem.                  │
├──────────────────────────────────────────────────────────────────┤
│ shared/              Types, enums, bounds, job transition table.   │
│                      Imported by both sides from source.           │
└──────────────────────────────────────────────────────────────────┘
```

`shared/` is consumed directly from TypeScript source — the backend resolves it through `tsconfig` paths
and the frontend through a Vite alias. There is deliberately no build step, so there is no `dist`-versus-
`src` version to drift.

---

## 3. Ports and adapters

The domain never imports Prisma, Express or Socket.IO. Three ports carry everything it needs.

### `PatientRepository`

The dataset and its evidence. Two implementations, held to **one shared contract test suite**
(`repositoryContract.ts`, 28 cases run twice):

- `PrismaPatientRepository` — SQLite, used by the running application
- `InMemoryPatientRepository` — used by the test suite and, crucially, by the naive-versus-guarded
  comparison, where each engine must run against a completely isolated copy of the same dataset so the
  unsafe engine can never touch the demo data

The contract exists because if the two adapters' semantics drift, every conclusion the test suite reaches
about safety stops applying to the running system. It pins down the behaviours a reimplementation would
plausibly get wrong: that a guarded write leaves `version` and every clinical field alone, that a failed
guard reports the row's *true* current version, that a zero-change online update does not consume a
version, and that re-deciding a record updates its ledger entry rather than adding a second one.

Two methods are deliberately separate rather than options on one another:

- `applyGuarded` — the only path that may persist derived fields, and it cannot be called without a guard
  version
- `applyUnguardedWholeRow` — the unsafe path, used *only* by the naive comparison engine. A separate,
  explicitly named method rather than a flag, so the unsafe path is impossible to reach by accident and
  trivially greppable in review.

### `JobRepository`

Job record, counters and checkpoints. Split from `PatientRepository` because they answer different
questions with different lifetimes: one is about the dataset being migrated, the other about the migration
attempt.

### `EventSink`

Assembled as three layers in the composition root, each with one job:

```
InMemoryEventSink      assigns gap-free sequence numbers, keeps the recent window
  └─ BufferedDbEventSink    batches the durable log so the engine's hot path stays clean
       └─ LiveEventBroadcaster  forwards significant events immediately, coalesces the rest
```

The domain only ever sees the outermost one as an `EventSink`, so none of this layering is visible to the
engines.

---

## 4. Data model

Nine tables. The interesting design decisions are in what is stored *separately*.

### `Patient`

Split conceptually into three blocks, and which code may write which block is the crux of the whole design:

| Block | Fields | Writable by |
|---|---|---|
| Identity / demographics | `patientCode`, `name`, `age`, `partitionIndex` | seeding only |
| **Clinical source data** | `bloodPressureSystolic`, `bloodPressureDiastolic`, `heartRate`, `glucose`, `diagnosis` | **online updates only** |
| **Derived** | `riskScore`, `riskLevel`, `backfillStatus`, `lastBackfillVersion` | **backfill engines only** |
| Version | `version` | **online updates only** |

### Why `version` means *source-data version*

This is the single most important modelling decision in the project, and it was chosen over the more
obvious alternative.

`version` is incremented **exclusively** by online updates. Backfill engines write the derived block and
never touch `version` or any clinical field.

The obvious alternative is a row version: bump it on every write, including the backfill's. That is what
most optimistic-concurrency examples do, and it would still prevent lost updates. It was rejected because
it destroys the project's best piece of evidence.

Under the source-data model, `lastBackfillVersion == version` is a **meaningful, independently checkable
statement**: *this record's score was derived from the clinical data it currently holds*. Anyone can verify
it with a single query, with no ledger and no trust in any counter:

```sql
SELECT COUNT(*) FROM Patient WHERE lastBackfillVersion < version;  -- records whose score is older than their data
```

Under a row-version model the backfill's own write would bump `version`, so `lastBackfillVersion` would
always equal `version` immediately after a write regardless of whether the data underneath had changed.
The comparison would be a tautology. The verification engine would have to fall back entirely to the write
ledger, and the per-patient "v4 / v2" display — the most informative column in the patient table — could
not exist.

### The evidence tables

Four tables exist purely so that correctness can be *audited* rather than asserted.

**`ConsiderationLedger`** — one row per record per job, `@@unique([jobId, patientId])`. This is the coverage
proof. "Every record was considered" becomes a set comparison rather than a counter to be trusted. The
uniqueness constraint is load-bearing: recovery legitimately revisits records, and a second row would
inflate coverage and could let a job claim 100% while having genuinely missed something. So re-deciding a
record **upserts**.

**`WriteLedger`** — one row per write *attempt*, applied or not, recording `guardVersion`,
`rowVersionAtWrite` (read inside the same transaction as the write), `applied`, `guarded` and
`wroteSourceFields`. This is what lets verification detect a stale overwrite independently of any engine
counter: an applied row whose `guardVersion < rowVersionAtWrite` is a stale write that landed.

`scoreWritten` is null on a refused write, because the column means *what landed*. The refused value lives
on the conflict row as `oldScore`. One fact, one place.

**`Conflict`** — a detected version collision, both versions, the field diff, the refused score, the applied
score and the resolution. Persisted *before* re-evaluation is attempted, so a crash midway leaves durable
evidence that a conflict existed rather than losing it.

**`PendingResult`** — computed-but-unwritten results, staged durably. See below.

### Why staged results are a table, not memory

The crash scenario needs a result that was computed from version N while the row has since moved to N+1.
For that staleness to survive the process dying, it has to be *durable*.

Framing this as "the crashed process remembered its own memory" would not survive scrutiny — a dead
process remembers nothing. So the engine is a genuine compute-then-write pipeline: a batch of results is
staged to `PendingResult` and flushed as guarded writes. Staging is a real durability step, of the kind a
real batch pipeline has, and it is what gives recovery something genuinely dangerous to reason about.

**`EventLog`** — the durable narrative, with gap-free sequence numbers. Diagnostic rather than evidence: if
an event insert fails, it is logged and dropped (and `droppedCount` is surfaced on the API), because
failing a backfill over a logging problem would turn an observability issue into a correctness one. The
ledgers are the evidence.

---

## 5. Event flow

```
domain engine
  └─ events.emit(...)                       (a port; the engine knows nothing else)
       └─ InMemoryEventSink                 sequence := n+1, push to ring buffer
            └─ BufferedDbEventSink          queue → batched insert (100ms / 50 rows)
                 └─ LiveEventBroadcaster
                      ├─ significant?  → io.emit('event', e)      immediately, never coalesced
                      └─ always       → io.emit('jobState', s)   throttled to ~10 Hz
```

`SIGNIFICANT_EVENT_TYPES` lives in `shared/`, so the server's broadcast policy and the client's
expectations cannot drift apart. Everything not on that list is high-volume per-record telemetry: still
persisted, but folded into throttled state frames for transport.

### Why there are three channels and not four

An earlier design also sent a lean `progress` frame carrying just metrics and partitions. It was removed
because it was a strict subset of `jobState`, so every update crossed the wire twice while the client still
needed `jobState` for status and checkpoint information anyway.

### Why `jobState` is throttled even for significant events

Building a state frame re-reads the consideration ledger to derive coverage. An earlier version pushed a
frame immediately on every significant event, which on a real run meant 472 frames in 19 seconds and
re-reading 1,000 ledger rows roughly 25 times a second. Significant *events* still arrive immediately and
uncoalesced; only the state frame is throttled.

### Why a snapshot on connect rather than replaying history

A client can connect at any point — mid-run, or after a dropped connection. Rebuilding state by replaying
events from zero would be slow and would need the whole log. Instead the server sends current state plus a
recent window, so a late or reconnecting client is correct immediately. That also makes reconnect
self-healing: whatever was missed is superseded by the snapshot that follows.

---

## 6. The single tick loop, and why determinism needs one

Every mutation in the simulation is dispatched from inside `SimulationOrchestrator.tick()`, in a fixed
order. Nothing else in the domain owns a timer.

The failure this prevents is worth being precise about. If the backfill advanced on its own timer while the
online-update simulator ran on a second timer, the interleaving of the two would depend on event-loop
scheduling. The set of records that conflict would differ between runs and between machines, so the demo
would report a different conflict count every time and the reproducibility claim would be unsatisfiable.

So:

- Participants (`OnlineUpdateSimulator`, `ScenarioManager`) register a `beforeStep` / `afterStep` hook and
  are called from inside the tick.
- `beforeStep` specifically, for update injection: it must land while the target record is still staged and
  unwritten. In `afterStep` the batch may already have flushed and the update would arrive too late to
  conflict with anything.
- Automatic updates and scenario steps trigger on **record counts**, never elapsed time.
- The `Clock` port provides pacing only. `backfillSpeed` changes how long a run takes in wall-clock terms
  and never the order in which anything happens.

Two guard tests enforce the other half mechanically: `setTimeout`, `setInterval`, `Math.random()`,
`Date.now()` and `new Date()` all fail the build if they appear anywhere in `src/domain`; and no test file
may use `setTimeout` or `await new Promise(...)` to synchronise.

### Why the scenario runner drives the loop itself

`ScenarioManager` calls `tickOnce()` in its own paced loop rather than letting `start()` spin up the
orchestrator's background loop. The reason is a hard constraint rather than a preference: the crash step
fires from inside a tick participant, and `crash()` awaits the loop to stop — so with the background loop
running it would await the very loop it is executing inside, and the demo would hang at its most important
moment.

### Restart behaviour

Job status and the cached verification report live in memory. On startup the orchestrator calls `restore()`,
which rebuilds status, timestamps, settings and metrics from the persisted job row — but **only for settled
runs**. A job recorded as `RUNNING`, `PAUSED`, `CRASHED` or `RECOVERING` had its engine state (batch
positions, the in-flight window) only in the dead process, so presenting it as resumable would be false.
Those are left at `IDLE` with the situation reported.

Without this, a restart after a completed audited run left the database holding everything while the
application reported `IDLE` — and re-running verification was then *refused*, because verification is only
permitted from a settled state.

---

## 7. Where each guarantee is enforced

| Guarantee | Enforced by | Audited by |
|---|---|---|
| No stale write lands | `applyGuarded` version predicate, in the database | `WriteLedger`, check C2 |
| No clinical update lost | Backfill writes cannot touch clinical fields (structurally) | `OnlineUpdate` replay, check C3 |
| Every record considered | `complete()` refuses to finish with a gap | `ConsiderationLedger`, check C1 |
| Stored score matches its data | The guarded write sets `lastBackfillVersion = guardVersion` | Recomputation, check C4 |
| Scores in range and correctly banded | Pure calculator with a clamp | Recomputation, check C5 |
| No conflict left unresolved | Bounded re-evaluation with a terminal `FAILED` outcome | `Conflict.resolution`, check C6 |
| Client cannot write derived fields | zod `strictObject` listing exactly five clinical fields | 41 API tests |

The right-hand column shares no code path with the middle one. That separation is the point.

---

## 8. Deliberate omissions

Things a production system would need that this does not have, stated so their absence is not mistaken for
an oversight:

- **No authentication or authorization.** Single-user demo; there is no user model at all.
- **No multi-process coordination.** One orchestrator owns the job. A real deployment would need leader
  election or a work-queue claim protocol; the per-record guarded write would be unchanged.
- **No migration versioning for the derived field itself.** A second backfill generation would need to
  distinguish "scored by formula v1" from "scored by v2". `RISK_CONFIG_VERSION` is stored alongside
  computed scores so the information exists, but nothing consumes it yet.
- **SQLite, single writer.** The version predicate is the same under Postgres; the transaction isolation
  characteristics are not identical and would want re-testing.
- **No rate limiting on the API** beyond a bounded body size and a per-socket resync throttle.
