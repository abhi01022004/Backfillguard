# BackfillGuard — Requirements

**Feature:** BackfillGuard — Safe Concurrent Healthcare Data Backfill
**Status:** Requirements draft for review
**Type:** Synthetic simulation platform for a hackathon demonstration

---

## 1. Problem statement

A hospital holds a large set of existing patient records and wants to compute a new derived
**Patient Risk Score** for all of them via a background backfill job.

While that backfill runs, clinical staff (doctors, nurses, laboratories) keep updating the same
records online. The backfill can be interrupted, can crash, and its checkpoint can be lost. A naive
backfill that resumes from stale in-flight state will reuse old source data and overwrite newer
legitimate clinical updates.

## 2. Central guarantee (the thing we must prove)

> Every eligible patient record is eventually considered, while no newer legitimate online update is
> overwritten by stale backfill data.

Both halves must be demonstrable from real system state, not from hard-coded numbers:

- **Liveness:** `consideredRecords == eligibleRecords`, `missedRecords == 0`
- **Safety:** `staleOverwrites == 0`, `lostOnlineUpdates == 0`

## 3. Scope

### In scope

Synthetic patient dataset, deterministic risk-score calculation, partitioned backfill engine with
optimistic concurrency control, online update simulator, checkpointing, crash/checkpoint-loss
injection, recovery engine, conflict re-evaluation engine, independent verification engine, naive
unsafe comparison engine, real-time dashboard, one-click deterministic demo, verification report
with export, automated tests, documentation.

### Out of scope

Real or de-identified patient data. Clinical decision support. Authentication/authorization.
Multi-tenant hospital administration. Kubernetes, Kafka, Redis, microservices, cloud queues.
Horizontal scaling of the backfill across processes.

### Non-negotiable framing

All data is synthetic. The risk score is a made-up formula. Every surface that shows a risk score
must carry: **"Synthetic Hackathon Risk Score — Not for Clinical Use"**.

---

## 4. Glossary

| Term | Definition |
|---|---|
| **Source version** (`version`) | Monotonic integer on a patient row, incremented **only** when clinical source fields change (online updates). Backfill writes never increment it. |
| **Derived fields** | `riskScore`, `riskLevel`, `backfillStatus`, `lastBackfillVersion`. Written only by backfill engines. |
| **`lastBackfillVersion`** | The source version the currently stored `riskScore` was computed from. |
| **Guarded write** | A conditional update `WHERE id = ? AND version = ?` that reports how many rows it changed. |
| **In-flight batch** | Results already computed in engine memory but not yet flushed to the database. This is what survives a crash and becomes stale. |
| **Stale overwrite** | A write that persists a derived value computed from source version `Vread` onto a row whose actual version at write time is `> Vread`. |
| **Lost online update** | A clinical source field value written by an online update that is later replaced by an older value from a backfill. |
| **Consideration** | A durable per-record ledger entry proving the job reached a final decision about that record. |
| **Post-consideration drift** | An online update that lands on a record *after* that record's own final consideration. The stored score is then correct as of the version it was considered at, but older than the newest data. Not a stale overwrite; reported separately as next-generation work. |

---

## 5. Requirements

Each requirement has a user story and acceptance criteria in EARS form. Requirement numbers are
referenced by `design.md` and `tasks.md`.

---

### R1 — Project foundation

**Story:** As a developer, I want a single-command monorepo so the whole system runs locally without
setup archaeology.

**Acceptance criteria**

1. WHEN a developer runs the documented install command THEN backend, frontend, and shared workspaces SHALL install from the repository root.
2. WHEN a developer runs the documented dev command THEN the backend API and the frontend dev server SHALL both start and the frontend SHALL successfully reach the backend health endpoint.
3. THE SYSTEM SHALL expose `GET /api/health` returning service status, database status, and app version.
4. THE SYSTEM SHALL read configuration from environment variables with committed safe defaults, and SHALL NOT require any secret to run the demo.
5. THE SYSTEM SHALL share TypeScript types between backend and frontend from a single `shared` workspace, with no duplicated enum definitions.
6. WHEN any unhandled error reaches the API boundary THEN the response SHALL be a structured JSON error envelope with a machine-readable `code`, and the error SHALL be logged with correlation to the request.

---

### R2 — Patient dataset and data model

**Story:** As a judge, I want a realistically sized synthetic dataset so the backfill looks like real
work.

**Acceptance criteria**

1. WHEN the database is seeded with default settings THEN the system SHALL create exactly 1,000 patients partitioned into 10 partitions of 100 records each.
2. THE SYSTEM SHALL support a configurable record count (100–5,000) and partition count (2–20), and SHALL distribute records across partitions deterministically and as evenly as possible.
3. THE SYSTEM SHALL store per patient: `id`, `patientCode`, `name`, `age`, `bloodPressureSystolic`, `bloodPressureDiastolic`, `heartRate`, `glucose`, `diagnosis`, `partitionIndex`, `version`, `riskScore`, `riskLevel`, `backfillStatus`, `lastBackfillVersion`, `createdAt`, `updatedAt`.
4. THE SYSTEM SHALL support `backfillStatus` values: `PENDING`, `PROCESSING`, `COMPLETED`, `CONFLICT`, `REEVALUATED`, `PROTECTED`, `FAILED`.
5. WHEN patients are generated THEN all names, codes, and clinical values SHALL come from a synthetic generator driven by a fixed seed, and SHALL NOT be sourced from any real dataset.
6. WHEN the same seed is used twice THEN the generated dataset SHALL be byte-for-byte identical.
7. WHEN a fresh dataset is seeded THEN every patient SHALL have `riskScore = null`, `riskLevel = null`, `lastBackfillVersion = null`, `backfillStatus = PENDING`, and `version >= 1`.
8. THE SYSTEM SHALL provide a reset operation that restores the dataset and clears all jobs, events, checkpoints, and ledgers in one action.

---

### R3 — Synthetic risk score calculator

**Story:** As a reviewer, I want one auditable, deterministic scoring module so score changes are
always explainable by input changes.

**Acceptance criteria**

1. THE SYSTEM SHALL implement risk scoring in exactly one backend module whose thresholds and weights are declared as a single exported configuration object.
2. WHEN given identical inputs THEN the calculator SHALL return an identical score, with no reliance on randomness, wall-clock time, or database state.
3. THE SYSTEM SHALL compute contributions from age, blood pressure, glucose, heart rate, and diagnosis according to the documented banding tables.
4. THE SYSTEM SHALL clamp the final score to the inclusive range 0–100.
5. THE SYSTEM SHALL derive `riskLevel` as `LOW` for 0–30, `MEDIUM` for 31–60, `HIGH` for 61–100.
6. WHEN a score is calculated THEN the calculator SHALL also return a per-factor breakdown suitable for display.
7. WHERE a risk score is displayed in the UI THEN the disclaimer "Synthetic Hackathon Risk Score — Not for Clinical Use" SHALL be visible in the same view.
8. THE SYSTEM SHALL be pure and side-effect free in this module, importable by tests without a database.

---

### R4 — Backfill engine

**Story:** As an operator, I want a partitioned backfill engine that never silently drops a record.

**Acceptance criteria**

1. WHEN a backfill job starts THEN the engine SHALL resolve the eligible record set, record `eligibleRecords`, and process partitions in ascending order.
2. FOR EACH record the engine SHALL: read the row, capture `sourceVersion`, compute the risk score, then perform a guarded write conditioned on `sourceVersion`.
3. WHEN the guarded write matches the current version THEN the engine SHALL persist the derived fields and record consideration outcome `APPLIED`.
4. WHEN the guarded write matches zero rows THEN the engine SHALL classify the result as stale, SHALL NOT retry unconditionally, and SHALL hand the record to the conflict engine.
5. THE SYSTEM SHALL write a durable consideration ledger entry for every eligible record with one terminal outcome from: `APPLIED`, `NO_ACTION_ALREADY_CURRENT`, `REEVALUATED_APPLIED`, `SKIPPED_NOT_ELIGIBLE`, `FAILED`.
6. THE SYSTEM SHALL track and expose: `eligibleRecords`, `processed`, `applied`, `conflicts`, `reevaluated`, `protectedUpdates`, `staleWriteAttemptsBlocked`, `failed`, `currentPartition`, `currentRecordIndex`, `percentComplete`.
7. WHEN a record raises an unexpected error THEN the engine SHALL retry up to a bounded number of attempts, and on final failure SHALL record outcome `FAILED` with the reason rather than skipping the record.
8. WHEN the engine finishes all partitions THEN the job SHALL transition to `COMPLETED` and SHALL NOT be reported as complete while any eligible record lacks a ledger entry.
9. THE SYSTEM SHALL keep all engine logic free of React, HTTP, and Socket.IO dependencies, communicating outward only through injected repository and event-sink ports.

---

### R5 — Version / optimistic concurrency control

**Story:** As a data owner, I want database-enforced version checks so a stale computation
physically cannot land.

**Acceptance criteria**

1. THE SYSTEM SHALL persist derived backfill fields only through a conditional update predicated on the source version observed at read time.
2. WHEN the conditional update affects zero rows THEN the system SHALL treat this as authoritative evidence of concurrent modification.
3. THE SYSTEM SHALL NOT infer safety from a re-read comparison alone; the write itself SHALL carry the version predicate.
4. WHEN a backfill engine writes derived fields THEN it SHALL NOT modify any clinical source field and SHALL NOT increment `version`.
5. WHEN a conflict occurs THEN the system SHALL record `patientId`, `sourceVersion`, `currentVersion`, detection timestamp, the old computed score, the new computed score, the changed input fields, and the resolution.
6. THE SYSTEM SHALL record every backfill write attempt in a write ledger containing the guard version, the row version at write time, whether the write applied, and the resulting `lastBackfillVersion`.
7. WHEN an online update is applied THEN it SHALL also use a version-guarded write so two concurrent online updates cannot silently lose one another.

---

### R6 — Online update simulator

**Story:** As a judge, I want to inject doctor and lab updates mid-backfill to create real
contention.

**Acceptance criteria**

1. THE SYSTEM SHALL apply online updates from actor types `DOCTOR`, `NURSE`, and `LAB`.
2. THE SYSTEM SHALL restrict online updates to the fields `bloodPressureSystolic`, `bloodPressureDiastolic`, `heartRate`, `glucose`, `diagnosis`.
3. WHEN an online update is applied THEN the patient `version` SHALL increment by exactly 1 and `updatedAt` SHALL advance.
4. WHEN an online update is applied THEN the system SHALL emit and persist an `ONLINE_UPDATE` event containing patient id and code, actor type, changed field names, previous values, new values, previous version, new version, and timestamp.
5. THE SYSTEM SHALL expose manual controls to trigger a doctor update and a lab update against a chosen or auto-chosen patient.
6. THE SYSTEM SHALL support an automatic update stream with a bounded, configurable frequency.
7. THE SYSTEM SHALL support a deterministic scripted update mode that targets predefined patient codes with predefined field values for the main demo.
8. WHEN an online update targets a nonexistent patient or an out-of-range value THEN the system SHALL reject it with a validation error and SHALL NOT mutate any row.

---

### R7 — Checkpoint system

**Story:** As an operator, I want checkpoints so an interrupted job knows where it was — and I want
to be able to destroy them to prove recovery works without them.

**Acceptance criteria**

1. THE SYSTEM SHALL persist a checkpoint containing `jobId`, `partitionIndex`, `recordPosition`, `processedCount`, `jobStatus`, and `createdAt`.
2. THE SYSTEM SHALL create a checkpoint automatically every N processed records, where N is configurable and defaults to 50.
2a. THE SYSTEM SHALL create checkpoints only at in-flight batch flush boundaries, and a checkpoint's `recordPosition` SHALL never reference a position beyond the last successfully flushed record.
3. WHEN a new checkpoint is created THEN prior checkpoints for that job SHALL be marked `SUPERSEDED` and exactly one SHALL be `ACTIVE`.
4. WHEN the operator triggers **Lose Checkpoint** THEN all checkpoints for the job SHALL be marked `LOST`, the job SHALL have no usable resume cursor, and all previously committed patient rows SHALL remain unchanged.
5. WHEN checkpoints are lost THEN the UI SHALL display `CHECKPOINT LOST` together with the last known partition and record position for narrative context only.
6. WHEN the operator triggers **Lose Checkpoint** while no checkpoint exists THEN the system SHALL return an actionable error and SHALL NOT change job state.
7. WHEN a job resumes THEN the engine SHALL NOT read a `LOST` checkpoint as a trusted cursor.

---

### R8 — Failure injection

**Story:** As a judge, I want to break the job on purpose and see that the database survives.

**Acceptance criteria**

1. THE SYSTEM SHALL provide Pause, Crash, Lose Checkpoint, and Resume controls.
2. WHEN the job is paused THEN processing SHALL stop at a record boundary and SHALL be resumable with no data loss.
3. WHEN the job crashes THEN the job status SHALL become `CRASHED`, a `BACKFILL_CRASHED` event SHALL be emitted, and no patient row SHALL be reverted or deleted.
4. WHEN the job crashes THEN the engine's unflushed in-flight batch SHALL be captured as pending stale results, retaining each entry's read-time source version and computed score.
5. WHEN the job crashes THEN already-committed derived values SHALL remain readable and identical to their pre-crash state.
6. THE SYSTEM SHALL make the sequence "process some records → crash → lose checkpoint → resume" reachable both manually and from the scripted demo.
7. WHEN a control is invoked in an incompatible job state THEN the API SHALL return HTTP 409 with a message naming the current state and the allowed transitions.

---

### R9 — Recovery engine

**Story:** As an operator, I want recovery that reconsiders the uncertain range using version
evidence instead of guessing.

**Acceptance criteria**

1. WHEN recovery starts without a usable checkpoint THEN the engine SHALL derive the recovery range from durable data evidence rather than from any in-memory cursor.
2. THE SYSTEM SHALL revisit records from a safe recovery boundary that is at or before the earliest record that could be in an unknown state, and SHALL NOT skip all records preceding the lost checkpoint.
3. FOR EACH revisited record the engine SHALL evaluate version evidence and SHALL choose exactly one of: no-op because the stored score already derives from the current version; process because the record was never scored or derives from an older version; or conflict handling.
4. THE SYSTEM SHALL NOT blindly rewrite records whose stored derived values are already current, and SHALL record those as `NO_ACTION_ALREADY_CURRENT` so they still count as considered.
5. WHEN recovery encounters a pending stale result from the crashed in-flight batch THEN it SHALL revalidate that result against the current version before any write.
6. WHEN recovery finishes the recovery range THEN it SHALL continue forward through all remaining partitions to completion.
7. WHEN recovery completes THEN a `RECOVERY_COMPLETED` event SHALL report records revisited, no-ops, records reprocessed, and conflicts found.
8. WHEN recovery cannot complete THEN the job SHALL enter `FAILED` with a stated reason and the UI SHALL surface it.

---

### R10 — Conflict detection and re-evaluation

**Story:** As a judge, I want to watch a conflict get caught and correctly resolved.

**Acceptance criteria**

1. WHEN a guarded write is rejected THEN the system SHALL emit `CONFLICT_DETECTED` with patient code, source version, current version, the changed input fields with old and new values, and the intended action.
2. WHEN a conflict is detected THEN the system SHALL emit `STALE_RESULT_REJECTED` and SHALL increment both `staleWriteAttemptsBlocked` and `protectedUpdates`.
3. WHEN re-evaluation begins THEN the system SHALL re-read the patient, recompute the score from current values, and perform a fresh guarded write against the newly observed version.
4. WHEN re-evaluation's guarded write succeeds THEN the record SHALL end with `backfillStatus = REEVALUATED`, ledger outcome `REEVALUATED_APPLIED`, and a `RE_EVALUATION_COMPLETED` event reporting the old score, the new score, and the resolution.
5. WHEN re-evaluation itself conflicts THEN the engine SHALL retry up to a bounded attempt limit before recording `FAILED`, and SHALL never fall back to writing the original stale value.
6. THE SYSTEM SHALL persist every conflict as a queryable record so the count shown in the UI is derived from stored rows.
7. THE SYSTEM SHALL display, per conflict, old risk score, new risk score, `Stale overwrite: PREVENTED`, and `Resolution: RE-EVALUATED`.

---

### R11 — Verification engine

**Story:** As a judge, I want an independent audit, not the engine grading its own homework.

**Acceptance criteria**

1. THE SYSTEM SHALL implement verification as a module that reads persisted state and recomputes findings, and SHALL NOT accept engine in-memory counters as evidence.
2. THE SYSTEM SHALL verify coverage by counting distinct eligible records with a ledger entry, and SHALL list the patient codes of any missing records.
3. THE SYSTEM SHALL verify safety by scanning the write ledger for any applied write whose guard version differed from the row version at write time, reporting the count as `staleOverwrites`.
4. THE SYSTEM SHALL verify that no online update was lost by resolving, per patient and **per field**, the most recent online update that set that field, and confirming the current row still holds that value, reporting `lostOnlineUpdates`.
5. THE SYSTEM SHALL verify derived-value consistency by recomputing the risk score from current row values for every record whose `lastBackfillVersion` equals `version`, and reporting mismatches as `inconsistentRecords`.
6. THE SYSTEM SHALL verify that every record with `backfillStatus = COMPLETED` or `REEVALUATED` has a non-null `riskScore` in 0–100 and a `riskLevel` consistent with that score.
7. THE SYSTEM SHALL verify that every recorded conflict has a terminal resolution, and SHALL report unresolved conflicts explicitly.
8. THE SYSTEM SHALL report records changed by an online update that arrived after that record's own final consideration as `postConsiderationDrift`, separately from `staleOverwrites`, and SHALL NOT count drift as a safety violation.
9. THE SYSTEM SHALL compute `eligibleRecords`, `consideredRecords`, `completedRecords`, `conflicts`, `reevaluated`, `protectedUpdates`, `staleWriteAttemptsBlocked`, `staleOverwrites`, `lostOnlineUpdates`, `missedRecords`, `inconsistentRecords`, `coveragePercent`.
10. WHEN `consideredRecords == eligibleRecords` AND `staleOverwrites == 0` AND `missedRecords == 0` AND `lostOnlineUpdates == 0` AND `inconsistentRecords == 0` THEN the verdict SHALL be `VERIFIED_SAFE`, otherwise `VERIFICATION_FAILED` with the failing checks named.
11. WHEN verification runs THEN it SHALL emit `VERIFICATION_STARTED` and then `VERIFICATION_PASSED` or `VERIFICATION_FAILED`.
12. THE SYSTEM SHALL NOT contain any code path that hard-codes, floors, or rounds a verification metric toward a passing value.

---

### R12 — Naive backfill comparison

**Story:** As a judge, I want proof that the safety mechanism is load-bearing.

**Acceptance criteria**

1. THE SYSTEM SHALL implement a naive engine that performs unconditional whole-row write-back, ignores version evidence, and flushes its pre-crash in-flight batch after recovery without revalidation.
2. THE SYSTEM SHALL run the guarded engine and the naive engine against the same seeded dataset and the same scripted scenario, on isolated dataset copies so neither run affects the other.
3. WHEN the comparison runs THEN the naive result SHALL report `staleOverwrites > 0` and `lostOnlineUpdates > 0`, measured by the same verification module used for the guarded run.
4. WHEN the comparison runs THEN the guarded result SHALL report `staleOverwrites == 0` and `lostOnlineUpdates == 0`.
5. THE SYSTEM SHALL present a side-by-side comparison including at least one concrete named patient showing the reverted clinical value and the stale score under naive versus the preserved value and re-evaluated score under BackfillGuard.
6. THE SYSTEM SHALL derive every comparison number from an actual run and SHALL NOT display any constant placeholder metric.
7. THE SYSTEM SHALL restrict the naive engine to the comparison feature so it can never write to the primary demo dataset.

---

### R13 — Real-time event stream

**Story:** As a judge, I want to watch the story unfold live.

**Acceptance criteria**

1. THE SYSTEM SHALL emit these event types: `BACKFILL_STARTED`, `RECORD_READ`, `RISK_CALCULATED`, `VERSION_VALIDATED`, `RECORD_UPDATED`, `ONLINE_UPDATE`, `CONFLICT_DETECTED`, `STALE_RESULT_REJECTED`, `RE_EVALUATION_STARTED`, `RE_EVALUATION_COMPLETED`, `CHECKPOINT_CREATED`, `CHECKPOINT_LOST`, `BACKFILL_PAUSED`, `BACKFILL_CRASHED`, `RECOVERY_STARTED`, `RECOVERY_COMPLETED`, `BACKFILL_COMPLETED`, `VERIFICATION_STARTED`, `VERIFICATION_PASSED`, `VERIFICATION_FAILED`.
2. EACH event SHALL carry a monotonic sequence number, timestamp, type, severity, human-readable message, and optional patient code and partition index.
3. THE SYSTEM SHALL push events to connected clients over a live transport so the dashboard updates without polling.
4. WHEN a client connects mid-run THEN it SHALL receive current job state plus recent event history so the view is immediately correct.
5. WHERE high-volume per-record events would exceed a bounded broadcast rate THEN the system SHALL coalesce progress updates for transport while still persisting the underlying events.
6. THE SYSTEM SHALL always broadcast semantically significant events (conflict, stale rejection, re-evaluation, checkpoint, crash, recovery, verification) without coalescing or dropping.
7. WHEN the live transport disconnects THEN the frontend SHALL show a disconnected indicator and SHALL recover state on reconnect.

---

### R14 — Main dashboard

**Story:** As a judge with 30 seconds, I want to understand the project from one screen.

**Acceptance criteria**

1. THE SYSTEM SHALL display the header "BackfillGuard", the subtitle "Safe Concurrent Healthcare Data Backfill", and the subtext "Protecting newer patient data during large-scale background migrations."
2. THE SYSTEM SHALL display KPI cards for Total Patients, Processed, Conflicts, Re-evaluated, Protected Updates, Stale Overwrites, and Coverage.
3. THE SYSTEM SHALL display sections for Backfill Progress, Partition Status, Live Online Activity, Conflict Detection, Recovery Timeline, and Verification Result.
4. THE SYSTEM SHALL display the current job state prominently at all times.
5. THE SYSTEM SHALL display a persistent "Synthetic Hackathon Data — Not for Clinical Use" banner.
6. THE SYSTEM SHALL render every KPI from server-provided state and SHALL show a distinguishable empty/zero state before a job runs rather than a placeholder value.
7. THE SYSTEM SHALL remain usable and readable at 1280×720 and above, and SHALL degrade to a single-column layout on narrow viewports.

---

### R15 — Partition visualization

**Acceptance criteria**

1. THE SYSTEM SHALL display every partition with its index, state, processed count, and total count.
2. THE SYSTEM SHALL support partition states `PENDING`, `PROCESSING`, `COMPLETED`, `RECOVERING`, `FAILED`, each visually distinct by both color and label.
3. THE SYSTEM SHALL show a per-partition progress bar reflecting actual processed counts.
4. WHEN a partition is being revisited by recovery THEN it SHALL render as `RECOVERING`.
5. WHEN a partition contains unresolved conflicts THEN the partition SHALL carry a conflict indicator with the count.

---

### R16 — Patient list and detail view

**Acceptance criteria**

1. THE SYSTEM SHALL provide a paginated, filterable patient list showing patient code, name, age, version, risk score, risk level, and backfill status.
2. THE SYSTEM SHALL support filtering by backfill status, risk level, and partition, and searching by patient code or name.
3. WHEN a patient is selected THEN the system SHALL show current demographics and clinical values, current version, current risk score with factor breakdown, and backfill status.
4. THE SYSTEM SHALL show a per-patient chronological history combining online updates, backfill reads, guarded write outcomes, conflicts, re-evaluations, and the final result.
5. EACH history entry SHALL show the version it relates to and, for online updates, the changed fields as `old → new`.
6. WHEN a patient had a conflict THEN the detail view SHALL show the rejected score, the re-evaluated score, and that the stale write was prevented.
7. THE SYSTEM SHALL show the risk-score disclaimer in the detail view.

---

### R17 — Simulation control panel

**Acceptance criteria**

1. THE SYSTEM SHALL provide controls: Start Backfill, Pause, Resume, Simulate Doctor Update, Simulate Lab Update, Crash Backfill, Lose Checkpoint, Resume Recovery, Run Verification, Reset Simulation.
2. THE SYSTEM SHALL provide bounded settings for record count, partition count, backfill speed, and online update frequency, with the valid range shown and enforced on the server.
3. WHEN a control is invalid in the current job state THEN the control SHALL be disabled with a tooltip explaining why.
4. WHEN a control invocation fails THEN the UI SHALL display the server's error message and the panel SHALL remain usable.
5. WHEN Reset Simulation is invoked THEN the system SHALL require explicit confirmation and then restore a pristine seeded state.
6. THE SYSTEM SHALL prevent settings changes while a job is running.

---

### R18 — One-click deterministic demo

**Acceptance criteria**

1. THE SYSTEM SHALL provide a single **Run Winning Demo** action that executes the full scripted scenario end to end without further input.
2. THE SCENARIO SHALL perform, in order: seed, start backfill, process several partitions, apply scripted online updates to predefined patients, continue processing, crash, lose checkpoint, resume recovery, detect conflicts, re-evaluate changed records, complete remaining records, run verification, display the result.
3. THE SCENARIO SHALL be keyed to processed-record counts rather than wall-clock time so ordering is independent of machine speed.
4. WHEN the scenario completes THEN it SHALL have produced at least 1 online update, at least 1 version conflict, at least 1 re-evaluation, exactly 1 checkpoint-loss episode, 1 successful recovery, `staleOverwrites == 0`, and `coveragePercent == 100`.
5. WHEN the scenario runs twice from the same seed THEN the conflict count, re-evaluation count, the set of conflicted patient codes, and all final risk scores SHALL be identical.
6. WHEN the scenario completes THEN at least one re-evaluated patient SHALL have changed `riskLevel`, so the impact is visible rather than numerical trivia.
7. THE SYSTEM SHALL display scenario progress as named steps with the current step highlighted.
8. WHEN the scenario is running THEN conflicting manual controls SHALL be disabled, and the scenario SHALL be abortable.

---

### R19 — Reproducible failure scenario

**Acceptance criteria**

1. THE SYSTEM SHALL define a focused scenario in which a specific patient is modified online after the backfill has read it and before the result is flushed.
2. WHEN the naive engine runs that scenario THEN the patient's newer clinical value SHALL be reverted and the stored score SHALL be stale, and the UI SHALL show `STALE OVERWRITE DETECTED`.
3. WHEN the guarded engine runs that scenario THEN the newer clinical value SHALL be preserved and the score SHALL reflect it, and the UI SHALL show `STALE OVERWRITE PREVENTED`.
4. THE SYSTEM SHALL display the concrete before/after values for that patient under both engines.
5. WHEN the scenario is run repeatedly THEN the outcome SHALL be identical every time.
6. THE SYSTEM SHALL cover this scenario with an automated test asserting both outcomes.

---

### R20 — Verification report

**Acceptance criteria**

1. THE SYSTEM SHALL render a report page showing job id, dataset description, seed, run timestamps, and duration.
2. THE REPORT SHALL show eligible records, records considered, coverage percent, conflicts, re-evaluated, protected online updates, stale overwrite attempts blocked, stale overwrites, lost online updates, missed records, inconsistent records, post-consideration drift, and final status.
3. THE REPORT SHALL list each verification check with pass/fail and, on failure, the offending patient codes.
4. THE REPORT SHALL include the plain-language guarantee statement: "Every eligible record was considered. Version conflicts were detected and re-evaluated. No newer online update was overwritten by stale backfill data."
5. THE SYSTEM SHALL allow exporting the report as JSON containing the full metric set and check results.
6. THE SYSTEM SHALL allow exporting the report as a PDF or print-optimized document.
7. WHEN verification has not been run THEN the report page SHALL say so and offer to run it, rather than rendering empty or stale numbers.

---

### R21 — Testing

**Acceptance criteria**

1. THE SYSTEM SHALL include automated tests covering: unchanged record is safely updated; changed record produces a conflict; stale result is rejected; changed record is re-evaluated; online update increments version; checkpoint creation; checkpoint loss forcing evidence-based recovery; recovery not blindly overwriting current records; every record eventually considered; final stale overwrite count is zero; naive engine demonstrates a stale overwrite; guarded engine prevents the same stale overwrite.
2. THE SYSTEM SHALL include unit tests for the risk calculator covering every band boundary and the 0–100 clamp.
3. THE SYSTEM SHALL include an integration test that runs the full demo scenario headlessly and asserts the R18.4 outcomes.
4. THE SYSTEM SHALL include a determinism test that runs the scenario twice and asserts identical results.
5. THE SYSTEM SHALL include frontend tests for KPI rendering from state, control enablement per job state, and conflict card rendering.
6. THE SYSTEM SHALL run its whole test suite from one root command in non-watch mode.
7. THE TEST SUITE SHALL be free of arbitrary sleeps for synchronization, using the tick-based scheduler instead.

---

### R22 — Data safety

**Acceptance criteria**

1. THE SYSTEM SHALL use only generated synthetic data and SHALL NOT include any real or re-identifiable patient information.
2. THE SYSTEM SHALL display "Synthetic Hackathon Data" persistently and "Not for Clinical Use" adjacent to every risk score presentation.
3. THE SYSTEM SHALL NOT claim clinical validity anywhere in the UI or documentation.
4. THE SYSTEM SHALL validate every API request body, path parameter, and query parameter against an explicit schema and reject unknown fields.
5. THE SYSTEM SHALL NOT expose any endpoint that accepts arbitrary column/value pairs, raw SQL, or direct writes to `riskScore`, `riskLevel`, `version`, or `lastBackfillVersion` from the client.
6. THE SYSTEM SHALL compute risk scores and version transitions exclusively server-side.
7. THE SYSTEM SHALL enforce numeric bounds on all clinical inputs server-side, independently of any client-side validation.
8. THE SYSTEM SHALL restrict CORS to the configured frontend origin and SHALL apply a bounded request body size limit.

---

### R23 — Error handling

**Acceptance criteria**

1. THE SYSTEM SHALL define distinct error codes for: patient not found, invalid input, version conflict, checkpoint missing, invalid job state transition, concurrent update failure, database error, recovery failure, scenario failure.
2. EACH error response SHALL include `code`, a human-readable `message`, and where applicable the relevant identifiers.
3. THE SYSTEM SHALL NOT swallow errors: every caught error SHALL be logged and either handled with a recorded outcome or propagated.
4. WHEN an engine error occurs mid-job THEN the job SHALL move to a valid state and the failure SHALL appear in the event stream.
5. THE FRONTEND SHALL surface errors as dismissible, actionable messages naming the failed action and the reason.
6. WHEN the backend is unreachable THEN the frontend SHALL show a clear connection error and a retry affordance instead of a blank screen.
7. THE SYSTEM SHALL NOT leak stack traces or internal SQL to API responses in production mode.

---

### R24 — Demo polish

**Acceptance criteria**

1. THE DASHBOARD SHALL communicate job state, progress, online activity, conflicts, recovery, and final proof without navigation.
2. THE SYSTEM SHALL visually emphasize conflict detected, stale write prevented, checkpoint lost, recovery, and verification success with distinct treatments.
3. THE SYSTEM SHALL use animation only to mark real state changes, and SHALL NOT show any loading or progress animation not backed by actual simulation state.
4. THE SYSTEM SHALL make the full scripted demo complete within a bounded, documented duration suitable for a live presentation.
5. THE SYSTEM SHALL keep the primary call to action visible above the fold on first load.
6. THE SYSTEM SHALL maintain readable contrast, keyboard-focusable controls, accessible names on icon-only buttons, and SHALL NOT convey state by color alone.

---

### R25 — Documentation

**Acceptance criteria**

1. THE SYSTEM SHALL include a root `README.md` covering problem, solution, architecture, technology stack, data model, backfill algorithm, version-control mechanism, recovery strategy, verification guarantees, demo instructions, testing instructions, limitations, and healthcare disclaimer.
2. THE SYSTEM SHALL include `docs/architecture.md`, `docs/backfill-algorithm.md`, and `docs/demo-script.md`.
3. THE DOCUMENTATION SHALL state exactly what is simulated and what is real engineering.
4. THE DEMO SCRIPT SHALL provide a timed narration outline a presenter can follow verbatim.
5. THE DOCUMENTATION SHALL be updated as part of the task that changes the behavior it describes.

---

## 6. Dependency map

```
R1 Foundation
 ├─> R2 Dataset ─┬─> R3 Risk Calculator
 │               └─> R4 Backfill Engine <── R5 Version Control
 │                    ├─> R6 Online Updates
 │                    ├─> R7 Checkpoints ──> R8 Failure Injection ──> R9 Recovery
 │                    ├─> R10 Conflict / Re-evaluation
 │                    └─> R11 Verification ──> R12 Naive Comparison ──> R19 Failure Scenario
 ├─> R13 Event Stream (needs R4, R6)
 └─> R14–R17 Frontend (needs R13)
                 └─> R18 Demo Mode (needs R4–R13, R17)
                      └─> R20 Report (needs R11)
R21 Testing spans R3–R12, R18, R19
R22, R23 cross-cutting from R1 onward
R24, R25 final
```

**Critical path:** R1 → R2 → R3 → R4/R5 → R7/R8 → R9 → R10 → R11 → R18. Everything visual depends
on that chain producing real state.

---

## 7. Risks

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| 1 | Non-determinism from wall-clock timers racing the engine loop | Demo produces different conflict counts each run; R18.5 fails | High | Tick-based orchestrator; scenario steps keyed to processed-record counts, never to `setTimeout` timing; single logical execution thread |
| 2 | Prisma engine download / native binary friction on Windows | Blocks all backend work at task 2 | Medium | Repository port abstraction from the start; `better-sqlite3` fallback adapter behind the same interface |
| 3 | SQLite write contention between engine writes, event inserts, and API reads | Slow demo, `SQLITE_BUSY` errors | Medium | WAL mode, batched event inserts, short transactions, single writer process |
| 4 | Event flood (1,000 records × several events) overwhelming the socket and browser | UI jank, dropped significant events | High | Coalesce progress frames; ring-buffer the timeline; always pass semantic events through uncoalesced |
| 5 | "Stale overwrite = 0" being true only by construction and therefore unconvincing | Judges discount the core claim | Medium | Independent verification by recomputation and write-ledger audit; the naive engine proves the guard is load-bearing on the same scenario |
| 6 | Naive comparison run corrupting the primary dataset | Verification of the real run becomes meaningless | Medium | Naive engine runs only against isolated in-memory dataset copies; enforced by the repository it is constructed with |
| 7 | Online updates arriving after a record's own consideration being misclassified as stale overwrites | False verification failure during a live demo | Medium | Explicit `postConsiderationDrift` metric; auto-update stream stops when the job completes; scripted demo only targets patients inside the in-flight window so drift is 0 |
| 8 | Scope creep into a hospital management system | Missed deadline, diluted narrative | Medium | Requirements freeze at R1–R25; no feature without a requirement id |
| 9 | Demo run too slow to fit a presentation slot | Live demo stalls | Medium | Configurable speed with a documented default; measured and recorded in the demo script |
| 10 | Frontend showing placeholder numbers that look like real metrics | Credibility failure if a judge probes | Low | R14.6 explicit zero/empty states; no default numeric literals in KPI components |
| 11 | Recovery boundary chosen too narrowly, silently skipping records | Breaks the central guarantee | Medium | Recovery revisits from the start of the earliest partition not provably complete; coverage ledger catches misses; dedicated test |
| 12 | Healthcare framing read as a real clinical tool | Reputational / ethical problem | Low | Persistent disclaimers per R22; documentation states the simulation boundary |

---

## 8. Definition of done

The feature is complete when this sequence is reproducible on a clean checkout:

```
seed 1,000 synthetic patients
→ backfill starts
→ scripted doctor/lab updates occur mid-run and bump versions
→ backfill crashes with an unflushed in-flight batch
→ checkpoint is lost
→ recovery begins from an evidence-derived boundary
→ previously processed and ambiguous records are reconsidered
→ version mismatches are detected
→ stale results are rejected
→ changed records are re-evaluated
→ remaining partitions complete
→ independent verification runs
```

with final output:

```
Coverage            = 100%
Missed Records      = 0
Stale Overwrites    = 0
Lost Online Updates = 0
STATUS              = VERIFIED SAFE
```

and the naive comparison, on the same scenario, reporting `staleOverwrites > 0` and
`lostOnlineUpdates > 0`, with the entire suite from R21 passing via one root command.
