# The backfill algorithm

> All patient data in this project is randomly generated. The risk score is an invented formula with no
> clinical meaning. See the [healthcare disclaimer](../README.md#healthcare-disclaimer).

---

## The problem

A derived field — a risk score — must be computed for every patient record. The dataset is large enough that
this takes a while, and the system cannot be taken offline: clinicians keep filing lab results and revising
observations throughout.

That produces a window in which a computed result is already wrong:

```
t0   backfill reads patient P0042 at version 2   (glucose 118)  → computes score 48
t1   a lab files a new glucose reading  118 → 210, version 2 → 3
t2   backfill writes score 48
```

At `t2` the score 48 describes data that no longer exists. Worse, a naive implementation built on
"load entity → mutate → save entity" writes the *whole row* back from its in-memory copy, which reverts
glucose to 118. The lab result is gone from the record, and — because the engine rescored from the reverted
value — the row ends internally consistent. Its score matches its data; both are simply wrong.

That last point is why this is hard to catch. A consistency check would pass.

---

## 1. Per-record algorithm

The guarded engine's inner loop. `phase` is `INITIAL` or `RECOVERY`.

```
for each partition p:
  for each record r in partition p, ordered by id:

    ── read ──────────────────────────────────────────────────────────
    row      := SELECT * FROM Patient WHERE id = r
    sourceV  := row.version                 -- the version this computation is based on
    snapshot := clinical fields of row       -- kept for the conflict diff

    ── compute (pure) ────────────────────────────────────────────────
    result := calculateRiskScore(snapshot)   -- no I/O, no clock, no randomness

    ── stage ─────────────────────────────────────────────────────────
    batch.push({ patientId, sourceV, snapshot, result })

    if batch.size == batchSize:
      flush(batch)

flush(batch):
  for each entry in batch:
    writeStaged(entry)
  batch := []
  lastFlushedPosition := currentIndex - 1     -- only ever a flushed position
```

Reading, computing and writing are separate phases on purpose. The gap between staging and flushing is the
in-flight window — the interval in which an online update can make a staged result stale — and it is what
the whole demo is about. Collapsing read-compute-write into one statement would remove the window and with
it the phenomenon being demonstrated.

---

## 2. The guarded write

One method on the repository port persists derived fields, and it cannot be called without a guard version.

```sql
UPDATE Patient
   SET riskScore = ?, riskLevel = ?, backfillStatus = ?, lastBackfillVersion = ?   -- = guardVersion
 WHERE id = ? AND version = ?                                                      -- the guard
```

Then, **inside the same transaction**, the row's actual version is read back and a `WriteLedger` row is
written for the attempt — applied or not.

Three properties matter, and each rules out a plausible wrong alternative:

**The predicate travels with the write.** Safety is never inferred from a separate re-read. A
`SELECT version` followed by an `UPDATE` has a window between them; `UPDATE ... WHERE version = ?` has none,
because the database evaluates the predicate and the write atomically. `applied == false` (zero rows matched)
is therefore *authoritative* evidence of concurrent modification, not a hint.

**The `SET` clause contains no clinical field and no `version`.** A backfill write is structurally incapable
of losing a clinical update, regardless of what the engine believes. This is why check C3 passing is not a
coincidence.

**`rowVersionAtWrite` is read in the same transaction.** It is a measurement of what the write actually saw,
not an inference from a later read. That is what makes the write ledger usable as independent evidence.

```
applied = true   → lastBackfillVersion = guardVersion, and the score describes current data
applied = false  → nothing changed; the row is at some version > guardVersion
```

### The unsafe path, for comparison only

`applyUnguardedWholeRow` has no version predicate and writes the whole row back from the stale snapshot. It
is a separate, explicitly named method rather than an option on `applyGuarded`, so the unsafe path is
impossible to reach by accident and trivially greppable. It sets `guarded = false` and
`wroteSourceFields = true` in the ledger, so a naive run cannot be mistaken for a safe one after the fact.

---

## 3. Conflict detection and re-evaluation

A refused write means the computed value is stale. The **only** correct response is to start over from
current data.

```
handleStaleWrite(patient, staleSnapshot, staleScore, sourceV, currentV):

  current       := re-read the row                       -- so the diff reflects reality
  changedFields := diff(staleSnapshot, current)

  conflictId := INSERT Conflict(sourceV, currentV, oldScore = staleScore, changedFields)
                                                         -- persisted BEFORE re-evaluating
  markStatus(patient, PROTECTED)                         -- transient; must become REEVALUATED
  emit CONFLICT_DETECTED, STALE_RESULT_REJECTED

  outcome := reevaluate(patient, staleScore)
  UPDATE Conflict SET resolution = outcome.resolved ? REEVALUATED : FAILED,
                      newScore   = outcome.newScore
```

```
reevaluate(patient, staleScore):
  attempts := 0
  while attempts < maxReevaluationAttempts:
    attempts++

    fresh      := re-read the row                   -- a NEW computation from NEWER data
    recomputed := calculateRiskScore(fresh)

    result := applyGuarded(patient, fresh.version, recomputed)   -- guard against what we just read

    if result.applied:
      ledger: REEVALUATED_APPLIED
      emit RE_EVALUATION_COMPLETED { staleOverwrite: 'PREVENTED' }
      return resolved

    -- another update landed while we were recomputing; loop and recompute from newer data

  ledger: FAILED
  emit RECORD_FAILED
  return unresolved
```

Two decisions here are load-bearing.

**There is deliberately no code path that writes the original value after a rejection.** That path is exactly
what the naive engine takes, and it is precisely the bug being demonstrated. A search of the codebase for a
retry that reuses `staleScore` finds nothing, because such a branch does not exist.

**Exhausted retries produce `FAILED`, not a fallback write.** A record that stays contended past the attempt
limit ends unresolved and is reported. Falling back to writing the stale value would be a silent correctness
violation that verification would then have to catch; an unresolved record is a visible, honest gap. The
consideration ledger still gets a terminal entry, so coverage is unaffected — the record *was* considered, and
the outcome was "could not be safely resolved".

Each retry re-reads before recomputing, so a retry is never a blind repeat. It is a new computation from
newer data.

---

## 4. Crash and the staged batch

`crash()` does two things and deliberately not a third.

```
crash():
  status := CRASHED               -- stop the loop first, so nothing advances while state is captured
  await loop to stop

  staged := engine.takeInFlightBatch()
  INSERT INTO PendingResult (staged)          -- durable: this is what carries staleness across the outage

  emit BACKFILL_CRASHED { stagedResultCount, stagedPatientIds }
```

**No patient row is touched.** Every already-committed derived value survives byte for byte — asserted by
test. A crash is not a rollback.

**The in-flight batch is staged durably.** Results computed but not yet written become rows in
`PendingResult`. This is what gives recovery something genuinely dangerous to reason about: a result computed
from version N, an update taking the row to N+1 during the outage, and then a resume that has to decide what
to do with that result.

---

## 5. Recovery: deriving the boundary from data

Recovery never consults a checkpoint. Whether one survives is irrelevant to correctness, which is the claim
the demo makes by destroying it first.

```
computePlan():
  -- Ask the data: which records already carry a score derived from their CURRENT version?
  for each partition p, ascending:
    records := SELECT * FROM Patient WHERE partitionIndex = p
    settled := every record where lastBackfillVersion == version AND riskScore IS NOT NULL

    if not all settled:
      recoveryStartPartition := p
      break

  return { recoveryStartPartition, stagedResults: SELECT * FROM PendingResult WHERE state = 'PENDING' }
```

The predicate `lastBackfillVersion == version AND riskScore IS NOT NULL` is exactly the statement "this
record's score was derived from the data it currently holds". Because `version` tracks source data only,
that comparison is meaningful — this is what the modelling decision in
[architecture §4](architecture.md#why-version-means-source-data-version) buys.

### The boundary can move backwards, and that is intended

If a clinician updated a record in partition 0 while the job was working in partition 3, partition 0 is no
longer settled — its score is now older than its data. The boundary lands on partition 0, *behind* where any
checkpoint would have pointed. A cursor-based resume would have skipped it and left a record permanently
stale.

This is the strongest argument for evidence-based recovery: it is not merely a way to survive losing a
cursor, it is *more correct* than a cursor.

### Revalidating staged results

```
for each staged entry:
  current := re-read the row
  if current.version == entry.sourceVersion:
    -- still safe: the row has not moved since the result was computed
    applyGuarded(entry.patientId, entry.sourceVersion, entry.result)
    state := REVALIDATED
  else:
    -- the row moved during the outage; the staged result is stale
    state := REJECTED
    recompute from current data and apply under a fresh guard
```

A rejected staged result is counted in `staleWriteAttemptsBlocked`. Note *why* that is correct even though no
refused-write row exists: recovery detects the staleness by comparison **before** attempting the write, so
the guard never fires. Counting only refused writes would under-report the safety mechanism working — the
comparison is the mechanism working.

### Revisiting without rewriting

From the boundary to the end of the dataset, every record is revisited. A record found already derived from
its current version is recorded as `NO_ACTION_ALREADY_CURRENT` and **left untouched**.

That outcome is the single best piece of evidence that recovery reasoned about the data rather than blindly
rewriting it. `RecoverySummary` separates `noops` from `recordsReprocessed` for exactly that reason: a
recovery that reported "revisited 800, rewrote 800" would be indistinguishable from one that had learned
nothing from the data.

A `decidedThisPass` set prevents the partition rescan from overwriting outcomes that staged-result
revalidation already decided for the same record.

---

## 6. Completion is refused, not assumed

```
complete():
  flush any remaining batch

  eligible  := SELECT id FROM Patient
  considered := SELECT patientId FROM ConsiderationLedger WHERE jobId = ?
  missing    := eligible − considered

  if missing is not empty:
    status := FAILED
    failureReason := "<n> eligible record(s) reached the end of the run without a terminal decision (P0042, ...)"
    emit RECORD_FAILED
    return

  status := COMPLETED
```

This is the liveness half of the guarantee made mechanical. The job **physically cannot** report success
while a record is unaccounted for, and the failure names the records rather than merely counting them. It is
a set difference, not a counter comparison, so no bookkeeping error can make it pass falsely.

---

## 7. The six verification checks

The audit takes repositories only — no engine, no counters, no in-memory state. Every number is derived by
re-reading persisted rows and recomputing. Each check is listed with **what it would catch**, because a check
whose failure mode you cannot name is not a check.

### C1 — Coverage

*Method:* set difference between all patient ids and the consideration ledger for this job.

*Would catch:* a record silently skipped — an off-by-one in a partition scan, a `continue` that forgot to
record an outcome, a batch dropped on an error path. A counter-based check would miss all three, because the
counter would simply never have been incremented.

### C2 — No stale overwrite

*Method:* re-read every `WriteLedger` row; fail on any with `applied = true AND guardVersion < rowVersionAtWrite`.

*Would catch:* the headline failure — a write that landed carrying data older than the row. This is measured
from the ledger rather than from a counter, so an engine that mis-attributed its own writes cannot hide it.

### C3 — No lost online update

*Method:* replay every `OnlineUpdate` row and check the patient still holds the value that update wrote,
field by field, accounting for later updates to the same field.

*Would catch:* the naive engine's actual failure. This is the **only** check that catches it. C4 passes for a
naive run — the engine reverts the clinical value and then rescores from the reverted value, so the row is
internally consistent. Its score matches its data; both are wrong. Without C3 the naive comparison would
show `inconsistentRecords = 0` on both sides and prove nothing.

### C4 — Derived consistency

*Method:* for every record claiming `lastBackfillVersion == version`, recompute the score from the clinical
values currently in the database and compare.

*Would catch:* a stored score that does not follow from its own data — a corrupted write, a partial update, a
score written from the wrong snapshot. This is the check that would catch a stale write *even if every
counter in the system said zero*, because the arithmetic simply would not agree.

Records where `lastBackfillVersion < version` are excluded and counted separately as
`postConsiderationDrift`. That is not a violation (see §8).

### C5 — Valid outputs

*Method:* for every completed record, check the score is present, within the clamp, and that its band label
matches the score.

*Would catch:* a null score on a record marked complete, a score outside 0–100, or a `riskLevel` that
disagrees with its `riskScore` — the signature of a level being written from a different computation than the
score.

### C6 — Conflicts resolved

*Method:* count conflicts still `PENDING`, and records left in the transient `PROTECTED` status.

*Would catch:* a conflict recorded and then abandoned — a re-evaluation path that returned without updating
the resolution, or an exception between "mark PROTECTED" and "mark REEVALUATED". `PROTECTED` surviving as a
terminal status means a record had a stale write blocked and was then never resolved either way.

### Falsifiability

A check that cannot fail proves nothing. Each has a companion test that deliberately breaks the invariant —
deletes a ledger row, injects an unguarded write, reverts a clinical value, corrupts a stored score,
mislabels a level, leaves a conflict pending — and asserts the verdict flips to `VERIFICATION_FAILED`.
"Stale overwrites = 0" is only meaningful because a non-zero is reachable.

There is deliberately no clamping, flooring or defaulting anywhere in the verification engine.

---

## 8. Post-consideration drift is not a violation

A record can be updated *after* it was correctly considered:

```
t0  backfill scores P0100 from v3    → lastBackfillVersion = 3, version = 3
t1  a nurse updates P0100            → version = 4
```

Now `lastBackfillVersion (3) < version (4)`. The score is older than the data. This is **not** a safety
violation: the record was considered, nothing stale was written over it, and no clinical value was lost. The
score is simply not the newest possible one.

It is reported as `postConsiderationDrift` rather than hidden, and the patient drawer explains it in words
rather than flagging it as a fault. Treating it as a failure would misrepresent normal, expected behaviour
and would make the real safety number less credible by inflating it with non-failures.

The resolution in a real system is a subsequent backfill generation, which would find exactly these records
via the same `lastBackfillVersion < version` predicate recovery uses.

---

## 9. Where each step is implemented

| Step | File |
|---|---|
| Per-record read / compute / stage / flush | `domain/engine/BackfillEngine.ts` |
| Guarded write, ledger row | `infra/repositories/PrismaPatientRepository.ts` → `applyGuarded` |
| Classifying a write outcome | `domain/engine/VersionValidator.ts` |
| Conflict record, re-evaluation loop | `domain/engine/ConflictEngine.ts` |
| Checkpoint cadence, destruction | `domain/engine/CheckpointManager.ts` |
| Boundary derivation, staged revalidation | `domain/engine/RecoveryEngine.ts` |
| Completion refusal | `domain/orchestrator/SimulationOrchestrator.ts` → `complete` |
| The six checks | `domain/verify/VerificationEngine.ts` |
| The unsafe engine | `domain/engine/NaiveBackfillEngine.ts` |
| Risk formula as data | `domain/risk/riskConfig.ts` |
