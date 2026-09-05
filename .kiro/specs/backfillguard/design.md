# BackfillGuard — Technical Design

**Feature:** BackfillGuard — Safe Concurrent Healthcare Data Backfill
**Requirements:** `.kiro/specs/backfillguard/requirements.md`

---

## 1. Design goals and the two ideas that drive everything

Two decisions shape this entire design. Everything else follows from them.

### Idea 1 — `version` means "source data version", not "row version"

The patient `version` column increments **only** when clinical source fields change. Backfill writes
touch only derived fields (`riskScore`, `riskLevel`, `backfillStatus`, `lastBackfillVersion`) and
never bump `version`.

This yields a single, checkable invariant:

```
For every correctly backfilled record:
    lastBackfillVersion == version
AND riskScore == computeRisk(current source fields)
```

That invariant is what makes verification *independent*. The auditor does not trust a counter; it
re-reads rows, recomputes the score, and compares. A stale overwrite is not a log line, it is a
detectable arithmetic fact: the stored score does not match the current data, and
`lastBackfillVersion < version`.

### Idea 2 — the stale value comes from an unflushed in-flight batch

A crash alone does not create staleness. Staleness needs *computed-but-unwritten* results that
outlive the interruption. So the engine buffers results in an in-flight batch (default 25 records)
before flushing. A crash freezes that batch into a `pending_results` table.

- **BackfillGuard** revalidates every pending result against the current version before flushing →
  conflicts detected → stale rejected → re-read → recompute → guarded write.
- **Naive engine** flushes the frozen batch verbatim, as a whole-row save → reverts newer clinical
  values and stores a stale score.

This is the realistic mechanism behind real-world backfill data loss, it makes the naive comparison
honest (same scenario, same data, same verifier), and it makes the guard demonstrably load-bearing.

**Framing this correctly matters.** A real process crash loses in-memory state, so `PendingResult`
must not be described as "the crash saved its memory" — that would not survive scrutiny. The correct
framing, used consistently in the docs and the demo narration: `PendingResult` is a **durable staging
table in a compute-then-write pipeline**. Large backfills are commonly built exactly this way — a
compute stage commits results to a staging table or queue, a write stage drains it. Those staged rows
outlive the crash precisely because they were committed, which is the entire point of staging them.
The stale data is therefore durable by design, and the question of what to do with it on resume is a
genuine engineering problem rather than a contrived one.

---

## 2. System architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend  (React + Vite + TS + Tailwind + Lucide + Recharts)        │
│  Pages: Dashboard │ Patients │ Comparison │ Verification Report      │
│  State: TanStack Query (REST) + useLiveStream (Socket.IO)            │
│  Zero backfill logic. Renders server state only.                     │
└───────────────┬───────────────────────────────┬─────────────────────┘
                │ REST /api/*                   │ Socket.IO /live
┌───────────────▼───────────────────────────────▼─────────────────────┐
│  API layer (Express)                                                 │
│  routes → zod validation → controller → service                      │
│  errorHandler │ requestLogger │ cors │ bodyLimit                     │
└───────────────┬─────────────────────────────────────────────────────┘
┌───────────────▼─────────────────────────────────────────────────────┐
│  Domain / simulation core  (no HTTP, no socket, no React)            │
│                                                                      │
│  SimulationOrchestrator ── owns the tick loop & job state machine    │
│    ├── BackfillEngine          (guarded)                            │
│    ├── NaiveBackfillEngine     (unsafe, comparison only)            │
│    ├── VersionValidator        (guarded-write outcome semantics)     │
│    ├── ConflictEngine          (detect → reject → re-evaluate)       │
│    ├── CheckpointManager                                             │
│    ├── RecoveryEngine          (evidence-based boundary)             │
│    ├── OnlineUpdateSimulator   (DOCTOR / NURSE / LAB)               │
│    ├── VerificationEngine      (independent audit)                   │
│    ├── ScenarioManager         (deterministic scripted demo)         │
│    └── riskCalculator          (pure, configurable)                  │
│                                                                      │
│  Ports: PatientRepository │ JobRepository │ EventSink │ Rng │ Clock  │
└───────────────┬─────────────────────────────────────────────────────┘
┌───────────────▼─────────────────────────────────────────────────────┐
│  Adapters:  PrismaPatientRepository (SQLite, WAL)                   │
│             InMemoryPatientRepository (tests + naive comparison)     │
│             SocketEventSink / BufferedDbEventSink                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Rule enforced by structure:** the domain layer imports nothing from `express`, `socket.io`,
`@prisma/client`, or `react`. It receives ports. This is what makes the engine unit-testable at
full speed and lets the naive engine run against an isolated in-memory copy (R12.7).

### Repository layout

```
backfillguard/
├── package.json                 # npm workspaces + root scripts
├── .env.example
├── README.md
├── docs/
│   ├── architecture.md
│   ├── backfill-algorithm.md
│   └── demo-script.md
├── shared/                      # @bg/shared — types & enums, zero runtime deps
│   └── src/
│       ├── enums.ts             # BackfillStatus, JobStatus, EventType, ...
│       ├── patient.ts
│       ├── job.ts
│       ├── events.ts
│       ├── verification.ts
│       ├── config.ts            # bounds for simulation settings
│       └── index.ts
├── backend/
│   ├── prisma/schema.prisma
│   └── src/
│       ├── index.ts             # composition root
│       ├── app.ts               # express app
│       ├── config/env.ts
│       ├── lib/{logger,errors,rng,clock}.ts
│       ├── domain/
│       │   ├── risk/riskCalculator.ts
│       │   ├── risk/riskConfig.ts
│       │   ├── ports/{PatientRepository,JobRepository,EventSink}.ts
│       │   ├── engine/{BackfillEngine,NaiveBackfillEngine,VersionValidator}.ts
│       │   ├── engine/{ConflictEngine,CheckpointManager,RecoveryEngine}.ts
│       │   ├── online/OnlineUpdateSimulator.ts
│       │   ├── verify/VerificationEngine.ts
│       │   ├── scenario/{ScenarioManager,demoScript.ts,failureScenario.ts}
│       │   └── orchestrator/SimulationOrchestrator.ts
│       ├── infra/
│       │   ├── db/prisma.ts
│       │   ├── repositories/{PrismaPatientRepository,InMemoryPatientRepository}.ts
│       │   ├── seed/{patientGenerator,seedRunner}.ts
│       │   └── events/{BufferedDbEventSink,SocketEventSink,EventBus}.ts
│       └── api/
│           ├── routes/{health,patients,backfill,online,checkpoint,scenario,verify,compare}.ts
│           ├── schemas/*.ts     # zod
│           └── middleware/{errorHandler,requestLogger,validate}.ts
├── frontend/
│   └── src/
│       ├── main.tsx, App.tsx
│       ├── api/{client,queries}.ts
│       ├── hooks/{useLiveStream,useJobState}.ts
│       ├── pages/{Dashboard,Patients,Comparison,Report}.tsx
│       └── components/
│           ├── layout/{Header,DisclaimerBanner,Nav}.tsx
│           ├── kpi/KpiCard.tsx
│           ├── backfill/{ProgressPanel,PartitionGrid,JobStateBadge}.tsx
│           ├── events/{EventTimeline,EventRow}.tsx
│           ├── conflict/{ConflictList,ConflictCard}.tsx
│           ├── patients/{PatientTable,PatientDetailDrawer,VersionHistory}.tsx
│           ├── controls/{ControlPanel,SettingsForm,DemoRunner}.tsx
│           ├── verify/{VerificationPanel,ChecklistRow}.tsx
│           └── compare/{ComparisonView,StaleOverwriteCallout}.tsx
└── tests/                       # cross-workspace integration tests
```

---

## 3. Data model

Prisma schema over SQLite. Enums are stored as strings (SQLite has no native enums); the shared
TypeScript union types are the source of truth.

```prisma
model Patient {
  id                     Int      @id @default(autoincrement())
  patientCode            String   @unique          // "P0001"
  name                   String
  age                    Int
  bloodPressureSystolic  Int
  bloodPressureDiastolic Int
  heartRate              Int
  glucose                Int
  diagnosis              String
  partitionIndex         Int                        // 0-based
  version                Int      @default(1)       // SOURCE data version
  riskScore              Int?
  riskLevel              String?                    // LOW | MEDIUM | HIGH
  backfillStatus         String   @default("PENDING")
  lastBackfillVersion    Int?                       // version the score derives from
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
  @@index([partitionIndex, id])
  @@index([backfillStatus])
}

model BackfillJob {
  id                 String   @id                   // "BG-DEMO-001"
  status             String                          // JobStatus
  mode               String                          // GUARDED | NAIVE
  seed               Int
  totalRecords       Int
  partitionCount     Int
  eligibleRecords    Int
  processed          Int      @default(0)
  applied            Int      @default(0)
  noopAlreadyCurrent Int      @default(0)
  conflicts          Int      @default(0)
  reevaluated        Int      @default(0)
  protectedUpdates   Int      @default(0)
  staleBlocked       Int      @default(0)
  failed             Int      @default(0)
  currentPartition   Int      @default(0)
  currentRecordIndex Int      @default(0)
  startedAt          DateTime @default(now())
  crashedAt          DateTime?
  recoveredAt        DateTime?
  completedAt        DateTime?
  failureReason      String?
}

model Checkpoint {
  id             Int      @id @default(autoincrement())
  jobId          String
  partitionIndex Int
  recordPosition Int
  processedCount Int
  jobStatus      String
  status         String   @default("ACTIVE")   // ACTIVE | SUPERSEDED | LOST
  createdAt      DateTime @default(now())
  @@index([jobId, status])
}

// Frozen unflushed in-flight batch — the source of staleness.
model PendingResult {
  id            Int      @id @default(autoincrement())
  jobId         String
  patientId     Int
  sourceVersion Int                            // version at read time
  computedScore Int
  computedLevel String
  inputSnapshot String                         // JSON of source fields as read
  state         String   @default("PENDING")   // PENDING | REVALIDATED | REJECTED | FLUSHED
  createdAt     DateTime @default(now())
  @@index([jobId, state])
}

// Proof of coverage: one terminal row per eligible record per job.
model ConsiderationLedger {
  id             Int      @id @default(autoincrement())
  jobId          String
  patientId      Int
  outcome        String   // APPLIED | NO_ACTION_ALREADY_CURRENT | REEVALUATED_APPLIED
                          // | SKIPPED_NOT_ELIGIBLE | FAILED
  sourceVersion  Int
  appliedVersion Int?
  attempts       Int      @default(1)
  phase          String   // INITIAL | RECOVERY
  reason         String?
  decidedAt      DateTime @default(now())
  @@unique([jobId, patientId])
}

// Proof of safety: every write attempt, guarded or not.
model WriteLedger {
  id                  Int      @id @default(autoincrement())
  jobId               String
  patientId           Int
  guardVersion        Int      // version the write was predicated on
  rowVersionAtWrite   Int      // actual version observed in the same transaction
  applied             Boolean
  guarded             Boolean  // false for naive engine
  scoreWritten        Int?
  resultingLastBfVer  Int?
  wroteSourceFields   Boolean  @default(false)  // naive whole-row write-back
  phase               String
  createdAt           DateTime @default(now())
  @@index([jobId, patientId])
}

model Conflict {
  id             Int      @id @default(autoincrement())
  jobId          String
  patientId      Int
  sourceVersion  Int
  currentVersion Int
  oldScore       Int
  newScore       Int?
  changedFields  String   // JSON [{field, from, to}]
  resolution     String   @default("PENDING") // PENDING | REEVALUATED | FAILED
  detectedAt     DateTime @default(now())
  resolvedAt     DateTime?
  @@index([jobId])
}

model OnlineUpdate {
  id              Int      @id @default(autoincrement())
  patientId       Int
  actorType       String   // DOCTOR | NURSE | LAB
  changedFields   String   // JSON [{field, from, to}]
  previousVersion Int
  newVersion      Int
  source          String   // MANUAL | AUTO | SCRIPTED
  createdAt       DateTime @default(now())
  @@index([patientId])
}

model EventLog {
  id             Int      @id @default(autoincrement())
  sequence       Int      @unique
  jobId          String?
  type           String
  severity       String   // INFO | SUCCESS | WARNING | CRITICAL
  message        String
  patientCode    String?
  partitionIndex Int?
  payload        String?  // JSON
  createdAt      DateTime @default(now())
  @@index([sequence])
}
```

### Why `ConsiderationLedger` and `WriteLedger` exist

Counters can drift, be double-incremented, or be reset. Coverage and safety are the two claims we
are making, so both get a durable per-record audit trail:

- **Coverage** = `COUNT(DISTINCT ConsiderationLedger.patientId) == eligibleRecords`, and the
  verifier can name the missing codes via a set difference.
- **Safety** = zero rows in `WriteLedger` where `applied = true AND guardVersion != rowVersionAtWrite`,
  plus zero rows where `wroteSourceFields = true AND applied = true` for a guarded job.

The `@@unique([jobId, patientId])` on the ledger makes recovery naturally idempotent: revisiting a
record upserts its outcome instead of inflating coverage.

---

## 4. Risk calculator (R3)

Single module, config object exported for auditing.

```ts
Blood pressure needs `AND` for the elevated band but `OR` for the high bands, so bands are declared
as an **ordered predicate list** (first match wins) rather than as min-value objects. Every factor
uses the same shape, which keeps the config uniformly auditable.

```ts
type Band<T> = { label: string; points: number; test: (v: T) => boolean };

export const RISK_CONFIG = {
  age: [
    { label: 'under40',  points: 5,  test: (a: number) => a < 40 },
    { label: '40to59',   points: 10, test: (a: number) => a <= 59 },
    { label: '60to69',   points: 20, test: (a: number) => a <= 69 },
    { label: '70plus',   points: 25, test: () => true },
  ],
  bloodPressure: [
    { label: 'veryHigh', points: 25, test: ({ s, d }) => s >= 160 || d >= 100 },
    { label: 'high',     points: 20, test: ({ s, d }) => s >= 130 || d >= 80  },
    { label: 'elevated', points: 10, test: ({ s, d }) => s >= 120 && d <  80  },
    { label: 'normal',   points: 5,  test: () => true },
  ],
  glucose: [
    { label: 'normal',   points: 5,  test: (g: number) => g < 100 },
    { label: 'elevated', points: 10, test: (g: number) => g <= 125 },
    { label: 'high',     points: 20, test: (g: number) => g <= 199 },
    { label: 'veryHigh', points: 25, test: () => true },
  ],
  heartRate: [
    { label: 'normal',   points: 5,  test: (h: number) => h >= 50 && h <= 90 },
    { label: 'elevated', points: 10, test: (h: number) => h >= 91 && h <= 110 },
    { label: 'high',     points: 15, test: () => true },   // > 110 or < 50
  ],
  diagnosis: { NONE: 0, ASTHMA: 3, OBESITY: 4, POST_SURGICAL_RECOVERY: 5,
               HYPERTENSION: 6, CHRONIC_KIDNEY_DISEASE: 8, DIABETES_TYPE_2: 8,
               CARDIAC_ARRHYTHMIA: 10 },
  levels: { LOW: [0, 30], MEDIUM: [31, 60], HIGH: [61, 100] },
  clamp: [0, 100],
} as const;

export function calculateRiskScore(input: RiskInput): RiskResult;
// → { score, level, breakdown: [{ factor, band, points }], configVersion }
```

Pure, no I/O, no `Date.now()`, no randomness. Max attainable = 25 + 25 + 25 + 15 + 10 = 100, so the
clamp is a guard rather than a routine truncation. The diagnosis factor is included specifically so
that a diagnosis-only online update changes the score — which the demo relies on for a visible
`riskLevel` escalation (R18.6).

---

## 5. Determinism strategy (Risk #1 — the biggest technical risk)

Async timers racing the engine loop is the single most likely way the demo becomes irreproducible.
Three mechanisms remove the race:

**1. One logical thread.** `SimulationOrchestrator` owns a single async tick loop. Every mutation —
backfill steps, online updates, checkpoint creation, crash injection, scenario steps — is dispatched
from inside `tick()`. The auto online-update simulator does **not** own a timer; the orchestrator
asks it for updates at deterministic tick boundaries.

```ts
async tick() {
  await this.scenario.beforeStep(this.state);        // scripted events fire here
  await this.onlineSim.maybeEmit(this.state);        // count-based, not time-based
  await this.engine.step();                          // exactly one record
  await this.checkpoints.maybeCheckpoint(this.state);
  await this.scenario.afterStep(this.state);
}
```

**2. Progress-keyed scheduling.** Scenario steps and auto online updates trigger on
`state.processed` counts, never on elapsed milliseconds. `backfillSpeed` only controls the delay
*between* ticks, so a fast or slow machine changes the wall-clock duration but never the ordering,
the conflict set, or the final scores.

```ts
// demoScript.ts — excerpt of the deterministic schedule
{ atProcessed: 180, action: 'SCRIPTED_ONLINE_UPDATES', patients: ['P0237','P0241', ...] },
{ atProcessed: 205, action: 'CRASH' },
{ atProcessed: 205, action: 'LOSE_CHECKPOINT' },
{ atProcessed: 205, action: 'RESUME_RECOVERY' },
```

**3. Seeded PRNG, injected.** `mulberry32(seed)` behind an `Rng` port. Patient generation, auto
update targeting, and value jitter all draw from it. `Math.random()` is banned in the domain layer
(enforced by an ESLint `no-restricted-globals`-style rule and a test that greps the domain folder).

Same seed + same script ⇒ identical conflicts, identical scores, identical verdict (R18.5).

---

## 6. Backfill engine (R4, R5)

### Job state machine

```
IDLE ──start──> RUNNING ──pause──> PAUSED ──resume──> RUNNING
                  │                                      │
                  ├──crash──> CRASHED ──resumeRecovery──> RECOVERING ──> RUNNING
                  │                                                        │
                  └──────────────────────── all partitions done ───────────┴──> COMPLETED
COMPLETED ──runVerification──> VERIFYING ──> VERIFIED_SAFE | VERIFICATION_FAILED
any ──unrecoverable──> FAILED        any ──reset──> IDLE
```

Transitions are validated in one table; an illegal transition throws `InvalidJobStateError` →
HTTP 409 naming current state and allowed next states (R8.7, R23.1).

### Per-record algorithm

```
1  read patient by (partition, index)                      → RECORD_READ
2  sourceVersion  := patient.version
   inputSnapshot  := { age, bpSys, bpDia, hr, glucose, diagnosis }
3  result := calculateRiskScore(inputSnapshot)             → RISK_CALCULATED
4  buffer result into in-flight batch (size 25)
5  when batch full OR partition ends → flush(batch)

flush(entry):
6  guarded write:
     UPDATE Patient
        SET riskScore=?, riskLevel=?, lastBackfillVersion=?, backfillStatus='COMPLETED'
      WHERE id=? AND version=?                            -- the guard
7  if rowsAffected == 1:
       WriteLedger(applied=true, guardVersion=v, rowVersionAtWrite=v, guarded=true)
       Ledger(outcome=APPLIED)                            → VERSION_VALIDATED, RECORD_UPDATED
   else:
       currentVersion := re-read version
       WriteLedger(applied=false, guardVersion=v, rowVersionAtWrite=currentVersion)
       Conflict(...)                                      → CONFLICT_DETECTED
       staleBlocked++, protectedUpdates++                 → STALE_RESULT_REJECTED
       hand to ConflictEngine.reevaluate(patientId)
```

The `rowsAffected == 0` outcome is the *authoritative* signal (R5.2). There is no "re-read then
write" pattern anywhere; the predicate travels with the write (R5.3).

### Prisma implementation of the guarded write

```ts
async applyGuarded(id: number, guardVersion: number, derived: DerivedFields) {
  return this.prisma.$transaction(async (tx) => {
    const res = await tx.patient.updateMany({
      where: { id, version: guardVersion },     // conditional update
      data: { ...derived, lastBackfillVersion: guardVersion },
    });
    const row = await tx.patient.findUniqueOrThrow({
      where: { id }, select: { version: true },
    });
    await tx.writeLedger.create({ data: {
      guardVersion, rowVersionAtWrite: row.version,
      applied: res.count === 1, guarded: true, wroteSourceFields: false, ...
    }});
    return { applied: res.count === 1, currentVersion: row.version };
  });
}
```

`updateMany` is used deliberately: Prisma's `update` requires a unique-only `where`, so it cannot
carry the version predicate. `updateMany` can, and returns the affected count — which is exactly the
compare-and-set signal we need.

### Re-evaluation loop (R10)

```
RE_EVALUATION_STARTED
  fresh := repo.findById(id)                    // re-read current values
  newResult := calculateRiskScore(fresh)        // recompute from CURRENT data
  { applied } := applyGuarded(id, fresh.version, newResult)
  if applied → status REEVALUATED, Conflict.resolution = REEVALUATED,
               Ledger(outcome=REEVALUATED_APPLIED)      → RE_EVALUATION_COMPLETED
  else       → attempt++, retry up to 3, then Ledger(FAILED)
```

The original stale value is never written as a fallback (R10.5). Between the conflict and the
re-evaluation, `backfillStatus` is `PROTECTED` — a stale write was blocked here — and it becomes
`REEVALUATED` on success. `PROTECTED` surviving as a terminal status means re-evaluation never
succeeded and is a verification failure.

---

## 7. Checkpoints and crash (R7, R8)

`CheckpointManager.maybeCheckpoint()` fires every 50 processed records: insert `ACTIVE`, mark the
previous one `SUPERSEDED`, emit `CHECKPOINT_CREATED`.

**Checkpoints are only created at flush boundaries**, and `recordPosition` always refers to the last
*successfully flushed* record — never to a record still sitting in the in-flight batch. Otherwise a
checkpoint would advertise progress past records that were never written, and a checkpoint-based
resume would skip them, silently breaking coverage. The defaults align (interval 50, batch 25) but
the rule is enforced in code rather than left to arithmetic coincidence: `maybeCheckpoint()` is
called from the post-flush path only, and asserts `recordPosition <= lastFlushedPosition`.

`crash()`:
1. stop the tick loop
2. persist the unflushed in-flight batch to `PendingResult` with each entry's read-time
   `sourceVersion`, `computedScore`, and `inputSnapshot`
3. `job.status = CRASHED`, `crashedAt = now`
4. emit `BACKFILL_CRASHED` with the pending-batch size
5. touch no `Patient` row — committed derived values survive verbatim (R8.5)

`loseCheckpoint()`: mark all of the job's checkpoints `LOST`, emit `CHECKPOINT_LOST` carrying the
last known partition/record for narration only. If no checkpoint exists → `CheckpointMissingError`
→ 409 (R7.6). The engine treats `LOST` checkpoints as unreadable for resume purposes (R7.7); a
deliberate guard in `CheckpointManager.getResumeCursor()` returns `null` for them so the code cannot
accidentally trust one.

---

## 8. Recovery engine (R9) — the evidence-based boundary

Without a checkpoint there is no trusted cursor, so the boundary is derived from data:

```ts
async computeRecoveryPlan(jobId): Promise<RecoveryPlan> {
  // A partition is provably complete only if every record in it has a ledger entry
  // AND every one of those records satisfies lastBackfillVersion == version.
  const provablyComplete = await this.findProvablyCompletePartitions(jobId);
  const boundary = firstGap(provablyComplete);       // lowest partition not provably complete

  return {
    recoveryStartPartition: boundary,                // revisit from here — NOT from the lost cursor
    pendingResults: await repo.pendingResults(jobId),
    trailingPartitions: [boundary + 1 .. partitionCount - 1],
  };
}
```

Then per record in the recovery range:

| Evidence | Decision | Ledger outcome |
|---|---|---|
| `lastBackfillVersion == version` and recompute matches stored score | leave the row untouched | `NO_ACTION_ALREADY_CURRENT` |
| `lastBackfillVersion == null` | never scored → process normally | `APPLIED` |
| `lastBackfillVersion < version` | source changed since scoring → recompute from current, guarded write | `APPLIED` / `REEVALUATED_APPLIED` |
| a `PendingResult` exists for it | revalidate `sourceVersion` vs current version; mismatch → conflict → re-evaluate; match → flush | `APPLIED` / `REEVALUATED_APPLIED` |
| unexpected error after retries | record and continue | `FAILED` |

This satisfies both halves of R9 explicitly: it does **not** skip everything before the lost
checkpoint (it revisits from the boundary), and it does **not** blindly rewrite everything (the first
row of the table is a genuine no-op that still counts as considered). After the recovery range, it
continues forward through all remaining partitions and emits `RECOVERY_COMPLETED` with
`{ revisited, noops, reprocessed, conflictsFound }`.

**Expected consequence, not a bug.** Because "provably complete" requires
`lastBackfillVersion == version`, an online update landing on an early partition while the engine
works on a late one makes that early partition un-provable again, and the boundary moves *backwards*
— possibly to partition 0, far earlier than the lost checkpoint. That is the correct reading of R9.2:
the engine has no evidence that record is still current, so it must look. Cost stays bounded because
the overwhelming majority of revisits take the `NO_ACTION_ALREADY_CURRENT` path, which is a read and
a comparison with no write. Expect the demo to show recovery revisiting a large span quickly and
rewriting very little; that shape *is* the correctness argument, and the recovery event payload
reports `noops` explicitly so the distinction is visible.

---

## 9. Online update simulator (R6)

```ts
async apply(patientId, actorType, changes, source): Promise<OnlineUpdateResult> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.patient.findUniqueOrThrow({ where: { id: patientId } });
    const res = await tx.patient.updateMany({
      where: { id: patientId, version: before.version },   // guarded here too (R5.7)
      data: { ...changes, version: before.version + 1 },
    });
    if (res.count !== 1) throw new ConcurrentUpdateError(patientId);
    // persist OnlineUpdate row + emit ONLINE_UPDATE with field-level from → to
  });
}
```

Only the five whitelisted clinical fields are accepted, each bounded server-side (systolic 70–250,
diastolic 40–150, heart rate 30–200, glucose 40–500, diagnosis from the enum). `riskScore`,
`riskLevel`, `version`, and `lastBackfillVersion` are not accepted from clients under any route
(R22.5). Note that the online update path deliberately does **not** recompute the risk score — the
score going stale relative to new data is the very phenomenon being demonstrated.

Three modes: `MANUAL` (UI button), `AUTO` (bounded frequency, count-driven from the tick loop),
`SCRIPTED` (fixed patient codes and values for the demo).

---

## 10. Verification engine (R11)

Six independent checks, each reading persisted state and recomputing:

| Check | Method | Metric |
|---|---|---|
| **C1 Coverage** | set difference between eligible patient ids and `ConsiderationLedger` ids | `consideredRecords`, `missedRecords`, `missingCodes[]` |
| **C2 No stale overwrite** | scan `WriteLedger` for `applied && guardVersion != rowVersionAtWrite`, plus `applied && wroteSourceFields` | `staleOverwrites` |
| **C3 No lost online update** | per patient **per field**, resolve the most recent `OnlineUpdate` that set that field; the current row must still hold that value | `lostOnlineUpdates` |
| **C4 Derived consistency** | for every row with `lastBackfillVersion == version`, recompute `calculateRiskScore(current)` and compare score + level | `inconsistentRecords` |
| **C5 Valid outputs** | every `COMPLETED`/`REEVALUATED` row has `riskScore` in 0–100 and a matching `riskLevel` | `invalidScoreRecords` |
| **C6 Conflicts resolved** | no `Conflict.resolution == 'PENDING'`, no terminal `backfillStatus == 'PROTECTED'` | `unresolvedConflicts` |

**C3 must resolve per field, not per update.** Comparing only the newest `OnlineUpdate` row against
the current values gives false positives: if a doctor sets `glucose` at v15 and a lab sets
`heartRate` at v16, the newest update mentions only `heartRate`, and the earlier `glucose` write
would look unverified. So C3 folds `changedFields` across all updates for a patient in version order
into a `Map<field, lastValueSet>` and compares each entry against the current row.

Plus the informational metric:

- **`postConsiderationDrift`** — rows where an `OnlineUpdate` arrived later than that record's own
  `ConsiderationLedger.decidedAt`. These are *not* safety violations (R11.8). A record scored
  correctly at v15 and then updated to v16 while the engine worked elsewhere satisfies both halves of
  the central guarantee: it was considered, and nothing stale was written over it. Its score is
  simply older than the newest reading, which is inherent to any backfill running against a live
  system and is resolved by the next backfill generation. Without this distinction one stray manual
  update would falsely fail a live demo. The auto-update stream stops on job completion, and the
  scripted demo only targets patients inside the in-flight window (so they get re-evaluated), which
  is why the happy path shows drift = 0.

Verdict: `VERIFIED_SAFE` iff C1–C6 all pass. The report lists each check with pass/fail and the
offending patient codes on failure.

**The credibility point (R11.1, R11.12):** C2, C3, and C4 never read an engine counter. C4 in
particular recomputes the score from the row that is in the database right now. If a stale value had
landed, C4 would catch it even if every counter in the system said zero. There is no code path that
clamps a metric toward passing, and a test asserts that a deliberately corrupted row makes
verification fail.

---

## 11. Naive comparison (R12, R19)

```ts
// Same scenario, same seed, same verifier, isolated datasets.
async function runComparison(seed: number): Promise<ComparisonResult> {
  const script = FAILURE_SCENARIO;                      // fixed
  const guarded = await runIsolated(new BackfillEngine(...),      seed, script);
  const naive   = await runIsolated(new NaiveBackfillEngine(...), seed, script);
  return { guarded, naive, spotlight: diffPatient(guarded, naive, script.spotlightCode) };
}
```

`runIsolated` constructs an `InMemoryPatientRepository` seeded from the same generator, so neither
run can touch the SQLite demo dataset (R12.7 is enforced by construction, not by discipline).

The naive engine differs in exactly three ways — narrow on purpose, so the comparison isolates the
guard rather than comparing two unrelated programs:

1. unconditional write (`where: { id }`, no version predicate)
2. whole-row write-back from its stale `inputSnapshot` → reverts newer clinical values
3. flushes frozen `PendingResult` entries without revalidation after recovery

**Tuning dependency to be aware of.** The naive run only exhibits a lost online update if a scripted
update targets a patient whose computed result is sitting in the frozen in-flight batch at crash
time. That couples the scenario script to `SIM_BATCH_SIZE`, so a careless change to the batch size
could silently defuse the headline comparison. Mitigation: the failure-scenario test asserts
`lostOnlineUpdates > 0` for the naive run, so the suite fails rather than the live demo.

Both results are scored by the **same** `VerificationEngine`. Expected, and asserted by test:

| | Coverage | Stale overwrites | Lost online updates |
|---|---|---|---|
| Naive | 100% | **> 0** | **> 0** |
| BackfillGuard | 100% | **0** | **0** |

The spotlight patient makes it concrete:

```
P0237   glucose 165 → doctor sets 190 (v15 → v16)

NAIVE:          glucose reverted to 165, riskScore 58 (from v15 data)
                STALE OVERWRITE DETECTED ❌   newer lab value lost
BACKFILLGUARD:  glucose 190 preserved, conflict detected at v15 vs v16,
                stale result rejected, re-evaluated → riskScore 68 (HIGH)
                STALE OVERWRITE PREVENTED ✅
```

---

## 12. API design

All bodies, params, and queries validated with zod; unknown keys rejected (`.strict()`).

| Method | Path | Purpose | Errors |
|---|---|---|---|
| GET | `/api/health` | service + db + version | — |
| GET | `/api/patients` | paginated list; filters `status`, `riskLevel`, `partitionIndex`, `q` | 400 |
| GET | `/api/patients/:code` | detail + risk breakdown | 404 |
| GET | `/api/patients/:code/history` | merged timeline for the patient | 404 |
| POST | `/api/seed` | reseed dataset `{ totalRecords, partitionCount, seed }` | 400, 409 if running |
| POST | `/api/backfill/start` | start job | 409 |
| POST | `/api/backfill/pause` | pause | 409 |
| POST | `/api/backfill/resume` | resume | 409 |
| POST | `/api/backfill/crash` | inject crash | 409 |
| POST | `/api/backfill/recover` | resume recovery | 409, 422 |
| GET | `/api/backfill/state` | job state + metrics + partitions | — |
| POST | `/api/checkpoint/lose` | mark checkpoints lost | 409 (no checkpoint) |
| GET | `/api/checkpoint` | active/last checkpoint | — |
| POST | `/api/online-update` | `{ patientCode?, actorType, changes? }` | 400, 404, 409 |
| GET | `/api/conflicts` | conflict list | — |
| GET | `/api/events` | recent events, `?sinceSequence=` | — |
| POST | `/api/verify` | run verification | 409 |
| GET | `/api/verify/latest` | latest report | 404 if never run |
| GET | `/api/verify/latest/export.json` | JSON export | 404 |
| POST | `/api/scenario/demo` | run the scripted demo | 409 |
| POST | `/api/scenario/abort` | abort scenario | 409 |
| GET | `/api/scenario/state` | step list + current step | — |
| POST | `/api/compare/run` | run guarded vs naive | 409 |
| GET | `/api/compare/latest` | comparison result | 404 |
| POST | `/api/reset` | full reset | 409 |

**Error envelope**

```json
{ "error": { "code": "VERSION_CONFLICT",
             "message": "Patient P0237 was modified concurrently (expected v15, found v16).",
             "details": { "patientCode": "P0237", "expectedVersion": 15, "currentVersion": 16 } } }
```

Codes: `VALIDATION_ERROR` 400 · `PATIENT_NOT_FOUND` 404 · `NOT_FOUND` 404 ·
`VERSION_CONFLICT` 409 · `CONCURRENT_UPDATE` 409 · `INVALID_JOB_STATE` 409 ·
`CHECKPOINT_MISSING` 409 · `RECOVERY_FAILED` 422 · `SCENARIO_FAILED` 422 · `DATABASE_ERROR` 500 ·
`INTERNAL_ERROR` 500. Stack traces are included only when `NODE_ENV !== 'production'` (R23.7).

### Live transport

Socket.IO namespace `/live`.

- On connect: server emits `snapshot` = `{ jobState, partitions, metrics, recentEvents (last 200) }`
  so a client joining mid-run is immediately correct (R13.4).
- `event` — one significant event, never coalesced (R13.6).
- `progress` — coalesced at ~10 Hz carrying `{ processed, currentPartition, percentComplete,
  partitionCounts }`. Per-record `RECORD_READ` / `RISK_CALCULATED` events are still persisted to
  `EventLog`; only their *broadcast* is folded into these frames (R13.5).
- The frontend shows a disconnected badge and refetches the snapshot on reconnect (R13.7).

---

## 13. Frontend design

**Stack:** React 18 + Vite + TS, Tailwind (light theme, healthcare-tech palette: slate neutrals,
teal primary, amber for conflicts, rose for stale/critical, emerald for verified), Lucide icons,
Recharts, TanStack Query for REST, a `useLiveStream` hook for the socket.

**Pages**

1. **Dashboard** — the 30-second view (R14, R24): header + disclaimer banner, job state badge,
   `RUN WINNING DEMO` above the fold, 7 KPI cards, progress panel, partition grid, event timeline,
   conflict list, recovery timeline, verification result card.
2. **Patients** — filterable table + detail drawer with version history (R16).
3. **Comparison** — naive vs guarded, spotlight patient callout, Recharts bar chart (R12, R19).
4. **Report** — full verification report, check-by-check, JSON + print/PDF export (R20).

**Charts (only where they add meaning):** risk-level distribution (before/after), processed-over-time
progress area chart, comparison bar chart of stale overwrites and lost updates. No decorative charts.

**Zero-state discipline (R14.6):** KPI components take `value: number | null`; `null` renders `—`
with a "no job yet" hint. No component has a numeric default, so a placeholder can never be mistaken
for a measurement.

**Animation discipline (R24.3):** transitions fire on real state changes only — a conflict card
flashes amber when its event arrives, the verification card scales in when the verdict lands. There
is no indeterminate spinner standing in for progress; progress bars are always bound to
`processed / total`.

**Accessibility (R24.6):** every state carries a text label alongside its color, icon-only buttons
get `aria-label`, disabled controls expose `title` explaining why, focus rings retained, the event
timeline is an `aria-live="polite"` region.

---

## 14. Testing strategy (R21)

| Layer | Tool | Coverage |
|---|---|---|
| Risk calculator | Vitest | every band boundary, clamp, level mapping, breakdown |
| Version validator | Vitest | apply / reject / retry semantics |
| Backfill engine | Vitest + `InMemoryPatientRepository` | R21.1 cases 1–4, 9, 10 |
| Online updates | Vitest | version increment, whitelist, bounds, concurrent guard |
| Checkpoints | Vitest | creation cadence, supersede, lose, no-cursor-after-loss |
| Recovery | Vitest | evidence boundary, no blind overwrite, no-op counting, pending revalidation |
| Verification | Vitest | passes on clean state; **fails** on deliberately corrupted row |
| Naive vs guarded | Vitest | R21.1 cases 11–12 on the same scenario |
| Demo scenario | Vitest integration | R18.4 assertions, headless, in-memory |
| Determinism | Vitest integration | run twice, deep-equal results |
| API | Vitest + supertest | validation rejection, error envelopes, 409 transitions |
| Frontend | RTL | KPI from state, control enablement per job state, conflict card, zero states |

The in-memory repository plus tick-based stepping means the whole suite runs in seconds with **no
`setTimeout` sleeps** (R21.7) — tests call `orchestrator.runToCompletion()` which drains ticks
synchronously.

---

## 15. Configuration

```
PORT=4000
NODE_ENV=development
DATABASE_URL="file:./data/backfillguard.db"
CORS_ORIGIN=http://localhost:5173
LOG_LEVEL=info

SIM_SEED=20260905
SIM_TOTAL_RECORDS=1000        # 100–5000
SIM_PARTITION_COUNT=10        # 2–20
SIM_BACKFILL_SPEED=25         # records/sec, 1–500
SIM_CHECKPOINT_INTERVAL=50    # 10–500
SIM_BATCH_SIZE=25             # in-flight batch, 1–100
SIM_ONLINE_UPDATE_FREQ=8      # updates per 100 records, 0–50
SIM_MAX_REEVAL_ATTEMPTS=3
```

Bounds live in `shared/src/config.ts` and are enforced by the same zod schema on both sides, so the
client cannot request an unbounded run (R17.2).

SQLite is opened with `PRAGMA journal_mode=WAL` and `busy_timeout=5000`, event inserts are batched
every 100 ms or 50 events, and all engine transactions are short — the mitigation for write
contention (Risk #3).

---

## 16. Performance budget

At the default 25 records/sec, 1,000 records take ~40 s of processing; the scripted demo including
crash, recovery, and verification lands at roughly 60–75 s. Recovery revisits the boundary partition
plus trailing partitions, so worst case is bounded by the record count. Event volume is ~5,000 rows
per full run — batched inserts keep this well within SQLite's capacity. The frontend caps the
rendered timeline at the most recent 200 events with a virtualized list for the full history.

---

## 17. Traceability

| Requirement | Design section |
|---|---|
| R1 | §2 layout, §12 API, §15 config |
| R2 | §3 data model, §5 seeded generation |
| R3 | §4 |
| R4 | §6 |
| R5 | §1 Idea 1, §6 guarded write, §3 `WriteLedger` |
| R6 | §9 |
| R7 | §7 |
| R8 | §1 Idea 2, §7 |
| R9 | §8 |
| R10 | §6 re-evaluation loop |
| R11 | §10 |
| R12, R19 | §11 |
| R13 | §12 live transport |
| R14–R17 | §13 |
| R18 | §5 determinism, §11 script |
| R20 | §10, §13 report page |
| R21 | §14 |
| R22 | §9 whitelist, §12 validation, §15 CORS |
| R23 | §12 error envelope, §6 state machine |
| R24 | §13 polish/animation/a11y discipline |
| R25 | §2 docs layout |
