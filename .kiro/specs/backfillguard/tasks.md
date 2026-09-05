# BackfillGuard — Implementation Plan

**Requirements:** `requirements.md` · **Design:** `design.md`

Tasks are ordered so that every task is executable when reached. Each carries the requirements it
satisfies and the tasks it depends on. Backend correctness (tasks 1–12) lands before any UI work.

---

## Phase A — Foundation

- [ ] 1. Scaffold the monorepo and verify both servers boot
  - [ ] 1.1 Create root `package.json` with npm workspaces (`shared`, `backend`, `frontend`) and scripts: `dev`, `dev:backend`, `dev:frontend`, `build`, `test`, `db:seed`, `db:reset`
    - Pin exact dependency versions; add `concurrently` for the combined dev script
    - _Requirements: R1.1, R1.2_
  - [ ] 1.2 Create the `shared` workspace with all enums and DTO types: `BackfillStatus`, `JobStatus`, `EventType`, `EventSeverity`, `ActorType`, `RiskLevel`, `ConsiderationOutcome`, `PartitionState`, patient/job/event/verification DTOs, and `config.ts` simulation bounds
    - Single source of truth; no enum may be redeclared in backend or frontend
    - _Requirements: R1.5, R2.4, R13.1_
  - [ ] 1.3 Create the backend Express app: `config/env.ts` (zod-validated env), `lib/logger.ts`, `lib/errors.ts` (typed error classes + code map), `middleware/errorHandler.ts`, `middleware/requestLogger.ts`, `middleware/validate.ts`, CORS restricted to the configured origin, bounded body size, and `GET /api/health`
    - _Requirements: R1.3, R1.4, R1.6, R22.8, R23.1, R23.2, R23.7_
  - [ ] 1.4 Create the frontend Vite + React + TS + Tailwind app with the light healthcare-tech palette, base layout shell, API client, and a health-check indicator proving it reaches the backend
    - _Requirements: R1.2, R14.7_
  - [ ] 1.5 Add `.env.example`, `.gitignore`, `data/` directory, and a placeholder `README.md`
    - _Requirements: R1.4_
  - [ ] 1.6 **Verify:** run the dev command, confirm the backend health endpoint responds and the frontend renders its health indicator green. Do not proceed until both run clean.
    - _Requirements: R1.2_

---

## Phase B — Data and scoring

- [ ] 2. Database schema, synthetic generator, and seeding
  - _Depends on: 1_
  - [ ] 2.1 Write `prisma/schema.prisma` with all ten models from design §3: `Patient`, `BackfillJob`, `Checkpoint`, `PendingResult`, `ConsiderationLedger`, `WriteLedger`, `Conflict`, `OnlineUpdate`, `EventLog`, plus indexes and the `ConsiderationLedger` unique `(jobId, patientId)`
    - Run the initial migration; enable WAL and `busy_timeout` on connection
    - _Requirements: R2.3, R2.4_
  - [ ] 2.2 Implement `lib/rng.ts` (`mulberry32` behind an `Rng` port) and `lib/clock.ts` (`Clock` port), so no domain code calls `Math.random()` or `Date.now()` directly
    - _Requirements: R2.6, R3.2_
  - [ ] 2.3 Implement `infra/seed/patientGenerator.ts`: seeded synthetic names from fixed first/last name pools, patient codes `P0001…`, bounded clinical values, diagnosis from the enum, deterministic even partition assignment
    - Deliberately place a spread of values across risk bands so the dataset is interesting
    - _Requirements: R2.1, R2.2, R2.5, R2.6_
  - [ ] 2.4 Implement `PatientRepository` port and both adapters: `PrismaPatientRepository` and `InMemoryPatientRepository`, including `applyGuarded()`, `findPage()`, `findByPartition()`, `pendingResults()`, and ledger writers
    - Both adapters must satisfy one shared contract test suite
    - _Requirements: R4.9, R5.1, R12.2, R12.7_
  - [ ] 2.5 Implement `seedRunner.ts` + the `db:seed` script: fresh patients with `riskScore = null`, `lastBackfillVersion = null`, `backfillStatus = PENDING`, `version = 1`; and a full reset that clears jobs, events, checkpoints, ledgers, conflicts, online updates, and pending results
    - _Requirements: R2.7, R2.8_
  - [ ] 2.6 Add `GET /api/patients`, `GET /api/patients/:code`, `POST /api/seed`, `POST /api/reset` with zod schemas rejecting unknown fields
    - _Requirements: R16.1, R16.2, R22.4, R22.5_
  - [ ] 2.7 **Test:** seeding produces exactly 1,000 patients across 10 partitions; two runs with the same seed are identical; two different seeds differ; contract tests pass for both repository adapters
    - _Requirements: R2.1, R2.6_

- [ ] 3. Risk calculator
  - _Depends on: 1.2_
  - [ ] 3.1 Implement `domain/risk/riskConfig.ts` with the exported `RISK_CONFIG` banding tables for age, blood pressure, glucose, heart rate, and diagnosis, plus level ranges and the clamp
    - _Requirements: R3.1, R3.3_
  - [ ] 3.2 Implement `domain/risk/riskCalculator.ts` — pure, no I/O, returning `{ score, level, breakdown }` with the clamp applied and level derived from the score
    - _Requirements: R3.2, R3.4, R3.5, R3.6, R3.8_
  - [ ] 3.3 **Test:** every band boundary (39/40, 59/60, 69/70; BP 119/120/129/130/159/160; glucose 99/100/125/126/199/200; HR 49/50/90/91/110/111), the clamp at both ends, all three level mappings, breakdown completeness, and determinism across repeated calls
    - _Requirements: R21.2_

---

## Phase C — Engine and correctness core

- [ ] 4. Version validator and guarded writes
  - _Depends on: 2.4, 3_
  - [ ] 4.1 Implement `VersionValidator` translating a guarded-write result into `APPLIED` / `STALE_REJECTED` with the observed current version
    - _Requirements: R5.1, R5.2, R5.3_
  - [ ] 4.2 Implement guarded write in `PrismaPatientRepository.applyGuarded()` using `updateMany({ where: { id, version } })` inside a transaction that also reads the row version and writes the `WriteLedger` entry
    - Assert in code that derived-field writes never touch source fields and never increment `version`
    - _Requirements: R5.1, R5.4, R5.6_
  - [ ] 4.3 Mirror the same semantics in `InMemoryPatientRepository.applyGuarded()`
    - _Requirements: R12.2_
  - [ ] 4.4 **Test:** matching guard version applies and writes a ledger row; mismatched guard version affects zero rows, applies nothing, and records `applied = false` with the true current version; a guarded derived write leaves all clinical fields and `version` untouched
    - _Requirements: R21.1 (1–3)_

- [ ] 5. Backfill engine and job state machine
  - _Depends on: 4_
  - [ ] 5.1 Implement the job state machine as a single transition table with `InvalidJobStateError` on illegal transitions, plus `JobRepository`
    - _Requirements: R8.7, R23.1, R23.4_
  - [ ] 5.2 Implement `BackfillEngine.step()`: read one record, capture `sourceVersion` and `inputSnapshot`, compute the score, buffer into the in-flight batch
    - _Requirements: R4.1, R4.2_
  - [ ] 5.3 Implement `flush()`: guarded write per buffered entry, `WriteLedger` + `ConsiderationLedger` entries, metric increments, and status transition to `COMPLETED`
    - _Requirements: R4.3, R4.5_
  - [ ] 5.4 Implement metric tracking for all of R4.6 and partition progress accounting
    - _Requirements: R4.6_
  - [ ] 5.5 Implement bounded per-record retry with a terminal `FAILED` ledger outcome and reason — never a silent skip
    - _Requirements: R4.7_
  - [ ] 5.6 Implement completion: refuse to report `COMPLETED` while any eligible record lacks a ledger entry
    - _Requirements: R4.8_
  - [ ] 5.7 Implement `SimulationOrchestrator` with the single tick loop from design §5 and progress-keyed dispatch; verify no domain module imports express, socket.io, or React
    - _Requirements: R4.9, R18.3_
  - [ ] 5.8 Add `POST /api/backfill/start`, `/pause`, `/resume`, and `GET /api/backfill/state`
    - _Requirements: R17.1, R8.1, R8.2_
  - [ ] 5.9 **Test:** an uncontended run applies every record, coverage ledger has one entry per eligible record, all records reach a terminal outcome, and the metric totals reconcile
    - _Requirements: R21.1 (1, 9)_

- [ ] 6. Online update simulator
  - _Depends on: 2.4, 5.7_
  - [ ] 6.1 Implement `OnlineUpdateSimulator.apply()` with a version-guarded transaction, +1 version increment, whitelisted fields only, and server-side numeric bounds
    - _Requirements: R6.1, R6.2, R6.3, R6.8, R5.7, R22.6, R22.7_
  - [ ] 6.2 Persist `OnlineUpdate` rows with actor type, field-level `from → to`, previous and new version, and source mode; emit `ONLINE_UPDATE`
    - _Requirements: R6.4_
  - [ ] 6.3 Implement the three modes: `MANUAL`, `AUTO` (count-driven from the tick loop, bounded frequency), `SCRIPTED` (fixed codes and values)
    - _Requirements: R6.5, R6.6, R6.7_
  - [ ] 6.4 Add `POST /api/online-update` with a strict zod schema; confirm no route accepts `riskScore`, `riskLevel`, `version`, or `lastBackfillVersion`
    - _Requirements: R22.4, R22.5_
  - [ ] 6.5 **Test:** an update increments the version by exactly 1; a non-whitelisted field is rejected; out-of-range values are rejected with no mutation; a stale-version update fails with `CONCURRENT_UPDATE`
    - _Requirements: R21.1 (5)_

- [ ] 7. Checkpoint manager
  - _Depends on: 5_
  - [ ] 7.1 Implement periodic checkpoint creation every N records with exactly one `ACTIVE` checkpoint and prior ones `SUPERSEDED`; emit `CHECKPOINT_CREATED`
    - Call `maybeCheckpoint()` from the post-flush path only, and assert `recordPosition <= lastFlushedPosition` so a checkpoint can never advertise unflushed progress
    - _Requirements: R7.1, R7.2, R7.2a, R7.3_
  - [ ] 7.2 Implement `loseCheckpoint()`: mark all of the job's checkpoints `LOST`, emit `CHECKPOINT_LOST` with the last known partition/record, mutate no patient row; throw `CheckpointMissingError` when none exists
    - _Requirements: R7.4, R7.5, R7.6_
  - [ ] 7.3 Implement `getResumeCursor()` returning `null` for `LOST` checkpoints so a lost checkpoint cannot be trusted as a cursor
    - _Requirements: R7.7, R9.1_
  - [ ] 7.4 Add `POST /api/checkpoint/lose` and `GET /api/checkpoint`
    - _Requirements: R17.1_
  - [ ] 7.5 **Test:** checkpoints appear at the configured cadence; only one is `ACTIVE`; losing them marks all `LOST`, leaves patient rows byte-identical, and yields a null resume cursor
    - _Requirements: R21.1 (6, 7)_

- [ ] 8. Crash and failure injection
  - _Depends on: 5, 7_
  - [ ] 8.1 Implement `crash()`: halt the tick loop, freeze the unflushed in-flight batch into `PendingResult` (with `sourceVersion`, `computedScore`, `inputSnapshot`), set `CRASHED`, emit `BACKFILL_CRASHED` with the pending count, touch no patient row
    - _Requirements: R8.3, R8.4, R8.5_
  - [ ] 8.2 Implement pause at a record boundary with lossless resume
    - _Requirements: R8.2_
  - [ ] 8.3 Add `POST /api/backfill/crash`; ensure all control endpoints return 409 with current state and allowed transitions when invoked in an incompatible state
    - _Requirements: R8.1, R8.7, R23.1_
  - [ ] 8.4 **Test:** after a crash, previously committed derived values are unchanged, pending results exist with their read-time versions, and the manual sequence "process → crash → lose checkpoint" is reachable
    - _Requirements: R8.6_

- [ ] 9. Recovery engine
  - _Depends on: 8_
  - [ ] 9.1 Implement `computeRecoveryPlan()`: derive the boundary from data evidence — the lowest partition not provably complete, where provably complete means every record has a ledger entry and `lastBackfillVersion == version`
    - _Requirements: R9.1, R9.2_
  - [ ] 9.2 Implement the per-record recovery decision table from design §8, including the genuine `NO_ACTION_ALREADY_CURRENT` no-op that still counts as considered
    - _Requirements: R9.3, R9.4_
  - [ ] 9.3 Implement pending-result revalidation: compare each frozen result's `sourceVersion` against the current version before any write; mismatch routes to the conflict engine
    - _Requirements: R9.5_
  - [ ] 9.4 Continue forward through all remaining partitions after the recovery range; emit `RECOVERY_STARTED` and `RECOVERY_COMPLETED` with revisited / noop / reprocessed / conflict counts
    - _Requirements: R9.6, R9.7_
  - [ ] 9.5 Implement recovery failure handling: `FAILED` with a stated reason surfaced through the event stream
    - _Requirements: R9.8, R23.4_
  - [ ] 9.6 Add `POST /api/backfill/recover`
    - _Requirements: R17.1_
  - [ ] 9.7 **Test:** recovery does not skip records before the lost checkpoint; already-current records are not rewritten (assert `updatedAt` and `WriteLedger` show no write) yet are counted as considered; recovery reaches 100% coverage
    - _Requirements: R21.1 (7, 8, 9)_

- [ ] 10. Conflict detection and re-evaluation
  - _Depends on: 4, 9_
  - [ ] 10.1 Implement `ConflictEngine.detect()`: persist a `Conflict` row with source version, current version, changed input fields, and old score; emit `CONFLICT_DETECTED` then `STALE_RESULT_REJECTED`; increment `staleBlocked` and `protectedUpdates`; set `backfillStatus = PROTECTED`
    - _Requirements: R10.1, R10.2, R10.6, R5.5_
  - [ ] 10.2 Implement `reevaluate()`: re-read, recompute from current values, fresh guarded write against the newly observed version, emit `RE_EVALUATION_STARTED` / `RE_EVALUATION_COMPLETED` with old score, new score, and resolution; set `REEVALUATED` and ledger `REEVALUATED_APPLIED`
    - _Requirements: R10.3, R10.4_
  - [ ] 10.3 Implement bounded re-evaluation retries ending in `FAILED`, with no fallback path that writes the original stale value
    - _Requirements: R10.5_
  - [ ] 10.4 Add `GET /api/conflicts`
    - _Requirements: R10.6_
  - [ ] 10.5 **Test:** a mid-flight online update produces exactly one conflict; the stale score is never persisted; the re-evaluated score equals a recomputation from post-update values; resolution is `REEVALUATED`; a permanently contended record ends `FAILED` rather than stale-written
    - _Requirements: R21.1 (2, 3, 4)_

- [ ] 11. Verification engine
  - _Depends on: 10_
  - [ ] 11.1 Implement check C1 coverage: eligible-id set difference against `ConsiderationLedger`, reporting `missedRecords` and the missing patient codes
    - _Requirements: R11.2_
  - [ ] 11.2 Implement check C2 safety: scan `WriteLedger` for applied writes where `guardVersion != rowVersionAtWrite` or `wroteSourceFields = true`
    - _Requirements: R11.3_
  - [ ] 11.3 Implement check C3 no lost online update: fold `changedFields` across a patient's updates in version order into a `Map<field, lastValueSet>` and confirm the current row still holds each value — per field, not per update
    - _Requirements: R11.4_
  - [ ] 11.4 Implement check C4 derived consistency: for every row with `lastBackfillVersion == version`, recompute the score from current values and compare score and level
    - _Requirements: R11.5_
  - [ ] 11.5 Implement checks C5 valid outputs and C6 conflicts resolved (no `PENDING` conflict, no terminal `PROTECTED`)
    - _Requirements: R11.6, R11.7_
  - [ ] 11.6 Implement `postConsiderationDrift` as a separate informational metric (online update later than that record's own `decidedAt`), and stop the auto online-update stream when the job completes
    - _Requirements: R11.8_
  - [ ] 11.7 Assemble the full metric set and the verdict rule; emit `VERIFICATION_STARTED` and `VERIFICATION_PASSED` / `VERIFICATION_FAILED`; confirm no metric is clamped, floored, or defaulted toward passing
    - _Requirements: R11.9, R11.10, R11.11, R11.12_
  - [ ] 11.8 Add `POST /api/verify`, `GET /api/verify/latest`, `GET /api/verify/latest/export.json`
    - _Requirements: R20.5_
  - [ ] 11.9 **Test:** verification passes on a clean completed run; deliberately corrupting one row's `riskScore` makes C4 fail; deleting one ledger entry makes C1 fail and names the code; injecting an unguarded stale write makes C2 fail. Verification must be provably falsifiable.
    - _Requirements: R21.1 (10), R11.1_

- [ ] 12. Naive engine and comparison harness
  - _Depends on: 11_
  - [ ] 12.1 Implement `NaiveBackfillEngine` differing in exactly three ways: unconditional write, whole-row write-back from the stale snapshot, and post-recovery flush of frozen pending results without revalidation
    - _Requirements: R12.1_
  - [ ] 12.2 Implement `runIsolated()` and the comparison harness: same seed, same scenario script, `InMemoryPatientRepository` per run, so the naive engine can never reach the SQLite demo dataset
    - _Requirements: R12.2, R12.7_
  - [ ] 12.3 Score both runs with the same `VerificationEngine` and produce a spotlight patient diff showing the reverted clinical value and stale score versus the preserved value and re-evaluated score
    - _Requirements: R12.3, R12.4, R12.5, R12.6_
  - [ ] 12.4 Add `POST /api/compare/run` and `GET /api/compare/latest`
    - _Requirements: R12.5_
  - [ ] 12.5 **Test:** on the identical scenario the naive run reports `staleOverwrites > 0` and `lostOnlineUpdates > 0` while the guarded run reports 0 and 0; the spotlight patient's outcome is identical across repeated runs
    - _Requirements: R21.1 (11, 12), R19.5, R19.6_

---

## Phase D — Real-time and frontend

- [ ] 13. Event stream
  - _Depends on: 5, 6, 10_
  - [ ] 13.1 Implement `EventSink` port, `EventBus`, monotonic sequence numbers, and `BufferedDbEventSink` batching inserts every 100 ms or 50 events
    - _Requirements: R13.1, R13.2_
  - [ ] 13.2 Wire Socket.IO `/live`: `snapshot` on connect (job state, partitions, metrics, last 200 events), uncoalesced `event` for significant types, `progress` frames coalesced at ~10 Hz for per-record volume
    - _Requirements: R13.3, R13.4, R13.5, R13.6_
  - [ ] 13.3 Confirm all 20 event types from R13.1 are emitted by the engines at the right points, each with message, severity, and optional patient code and partition
    - _Requirements: R13.1, R13.2_
  - [ ] 13.4 Add `GET /api/events?sinceSequence=`
    - _Requirements: R13.4_
  - [ ] 13.5 **Test:** sequence numbers are strictly increasing with no gaps; significant events are never coalesced away; a client connecting mid-run receives a correct snapshot

- [ ] 14. Dashboard shell, KPIs, and progress
  - _Depends on: 13_
  - [ ] 14.1 Build `Header`, persistent `DisclaimerBanner` ("Synthetic Hackathon Data — Not for Clinical Use"), nav, and `JobStateBadge`
    - _Requirements: R14.1, R14.4, R14.5, R22.2_
  - [ ] 14.2 Build `useLiveStream` and `useJobState` hooks with reconnect handling, snapshot refetch, and a disconnected indicator
    - _Requirements: R13.7, R23.6_
  - [ ] 14.3 Build `KpiCard` and the seven KPI cards, with `value: number | null` rendering an explicit zero/empty state and no numeric defaults
    - _Requirements: R14.2, R14.6_
  - [ ] 14.4 Build `ProgressPanel` bound to real `processed / total`, plus the recovery timeline section
    - _Requirements: R14.3, R24.3_
  - [ ] 14.5 Verify the layout at 1280×720 and single-column on narrow viewports
    - _Requirements: R14.7_

- [ ] 15. Partition visualization
  - _Depends on: 14_
  - [ ] 15.1 Build `PartitionGrid` showing index, state, processed/total, and a real progress bar per partition
    - _Requirements: R15.1, R15.3_
  - [ ] 15.2 Implement all five partition states with distinct color **and** label, including `RECOVERING` during recovery
    - _Requirements: R15.2, R15.4, R24.6_
  - [ ] 15.3 Add a conflict indicator with count on partitions holding unresolved conflicts
    - _Requirements: R15.5_

- [ ] 16. Event timeline and conflict display
  - _Depends on: 14_
  - [ ] 16.1 Build `EventTimeline` / `EventRow` with per-type icons and severity styling, capped at 200 rendered rows, `aria-live="polite"`
    - _Requirements: R13.3, R24.2, R24.6_
  - [ ] 16.2 Build `ConflictList` / `ConflictCard` showing patient code, source vs current version, changed inputs, old score, new score, `Stale overwrite: PREVENTED`, `Resolution: RE-EVALUATED`
    - _Requirements: R10.7, R24.2_
  - [ ] 16.3 Apply emphasis treatments for conflict, stale write prevented, checkpoint lost, recovery, and verification success, animating only on real state change
    - _Requirements: R24.2, R24.3_

- [ ] 17. Patient list and detail view
  - _Depends on: 14_
  - [ ] 17.1 Build `PatientTable`: paginated, filter by status / risk level / partition, search by code or name
    - _Requirements: R16.1, R16.2_
  - [ ] 17.2 Add `GET /api/patients/:code/history` merging online updates, backfill reads, write outcomes, conflicts, re-evaluations, and the final result into one chronological timeline
    - _Requirements: R16.4, R16.5_
  - [ ] 17.3 Build `PatientDetailDrawer` with demographics, clinical values, current version, risk score with factor breakdown, backfill status, and the disclaimer
    - _Requirements: R16.3, R16.7, R3.7_
  - [ ] 17.4 Build `VersionHistory` rendering per-version entries, `old → new` field diffs, and the conflict/re-evaluation narrative with the rejected and final scores
    - _Requirements: R16.4, R16.5, R16.6_

- [ ] 18. Simulation control panel
  - _Depends on: 14, 5.8, 7.4, 8.3, 9.6, 11.8_
  - [ ] 18.1 Build `ControlPanel` with all ten controls from R17.1
    - _Requirements: R17.1_
  - [ ] 18.2 Build `SettingsForm` for record count, partition count, backfill speed, and update frequency, showing bounds, validating with the shared schema, and locking while a job runs
    - _Requirements: R17.2, R17.6_
  - [ ] 18.3 Implement per-state control enablement with tooltips explaining why a control is disabled
    - _Requirements: R17.3, R24.6_
  - [ ] 18.4 Implement error surfacing: dismissible messages naming the failed action and the server reason, panel stays usable
    - _Requirements: R17.4, R23.5_
  - [ ] 18.5 Implement Reset Simulation with a confirmation step
    - _Requirements: R17.5, R2.8_
  - [ ] 18.6 **Test (RTL):** KPI rendering from state, control enablement per job state, conflict card rendering, zero states
    - _Requirements: R21.5_

---

## Phase E — Demo, comparison, report

- [ ] 19. One-click deterministic demo
  - _Depends on: 12, 18_
  - [ ] 19.1 Implement `demoScript.ts`: the ordered step list keyed to `atProcessed` counts covering seed → start → scripted online updates → crash → lose checkpoint → resume recovery → conflicts → re-evaluation → completion → verification
    - _Requirements: R18.1, R18.2, R18.3_
  - [ ] 19.2 Implement `ScenarioManager` with `beforeStep` / `afterStep` hooks driven by the orchestrator, named step progress, and abort support
    - _Requirements: R18.7, R18.8_
  - [ ] 19.3 Tune the scripted patient set so the run yields ≥1 online update, ≥1 conflict, ≥1 re-evaluation, exactly one checkpoint-loss episode, one recovery, `staleOverwrites == 0`, and 100% coverage — and so at least one re-evaluated patient changes `riskLevel`
    - _Requirements: R18.4, R18.6_
  - [ ] 19.4 Add `POST /api/scenario/demo`, `POST /api/scenario/abort`, `GET /api/scenario/state`
    - _Requirements: R18.1_
  - [ ] 19.5 Build `DemoRunner`: the `RUN WINNING DEMO` button above the fold, the named step list with the current step highlighted, and disabling of conflicting manual controls while running
    - _Requirements: R18.7, R18.8, R24.5_
  - [ ] 19.6 **Test (integration):** the scenario runs headlessly and asserts every R18.4 outcome; running it twice from the same seed produces identical conflict counts, conflicted code sets, and final scores
    - _Requirements: R21.3, R21.4, R18.5_

- [ ] 20. Failure scenario comparison view
  - _Depends on: 12, 19_
  - [ ] 20.1 Implement `failureScenario.ts`: a focused script modifying one spotlight patient after its read and before the flush
    - _Requirements: R19.1_
  - [ ] 20.2 Build `ComparisonView` and `StaleOverwriteCallout` showing `STALE OVERWRITE DETECTED ❌` for naive and `STALE OVERWRITE PREVENTED ✅` for BackfillGuard, with concrete before/after values for the spotlight patient
    - _Requirements: R19.2, R19.3, R19.4_
  - [ ] 20.3 Add the comparison bar chart of stale overwrites and lost online updates, bound to real run results
    - _Requirements: R12.5, R12.6_

- [ ] 21. Verification report page
  - _Depends on: 11, 19_
  - [ ] 21.1 Build the report page: job id, dataset description, seed, run timestamps, duration, and the full metric table from R20.2
    - _Requirements: R20.1, R20.2_
  - [ ] 21.2 Render the check-by-check list with pass/fail and offending patient codes on failure
    - _Requirements: R20.3, R11.10_
  - [ ] 21.3 Add the plain-language guarantee statement and the `VERIFIED SAFE` verdict treatment
    - _Requirements: R20.4, R24.2_
  - [ ] 21.4 Implement JSON export of the full metric set and check results
    - _Requirements: R20.5_
  - [ ] 21.5 Implement PDF export as a print stylesheet plus `window.print()`, letting the browser's native "Save as PDF" produce the file
    - Deliberately no jsPDF (fights Tailwind layout) and no Puppeteer (~300MB Chromium for one button)
    - _Requirements: R20.6_
  - [ ] 21.6 Implement the not-yet-run state offering to run verification instead of showing empty or stale numbers
    - _Requirements: R20.7_
  - [ ] 21.7 Add the risk-level distribution and progress-over-time charts where they aid understanding
    - _Requirements: R14.3_

---

## Phase F — Hardening, safety, documentation

- [ ] 22. Test suite completion and CI-ready run
  - _Depends on: 19, 20, 21_
  - [ ] 22.1 Audit the mandatory list: confirm all twelve R21.1 cases have a named, asserting test
    - _Requirements: R21.1_
  - [ ] 22.2 Add API tests with supertest: schema rejection, error envelope shape, 409 on illegal transitions, no route accepting protected fields
    - _Requirements: R22.4, R22.5, R23.1, R23.2_
  - [ ] 22.3 Remove every sleep-based synchronization from tests in favour of tick draining
    - _Requirements: R21.7_
  - [ ] 22.4 Wire the root `test` command to run backend and frontend suites in non-watch mode; run it clean
    - _Requirements: R21.6_
  - [ ] 22.5 Add a guard test asserting no `Math.random()`, `Date.now()`, `new Date()`, or `setTimeout` usage inside `backend/src/domain` — all three are determinism hazards and `setTimeout` in particular would reintroduce the wall-clock race the tick loop exists to remove
    - _Requirements: R3.2, R18.5_

- [ ] 23. Security, data safety, and error-handling audit
  - _Depends on: 22_
  - [ ] 23.1 Audit every route for zod validation of body, params, and query with unknown-key rejection, and confirm the body-size limit and CORS restriction
    - _Requirements: R22.4, R22.8_
  - [ ] 23.2 Confirm no endpoint accepts arbitrary column/value pairs, raw SQL, or direct writes to `riskScore`, `riskLevel`, `version`, `lastBackfillVersion`
    - _Requirements: R22.5, R22.6_
  - [ ] 23.3 Confirm all clinical bounds are enforced server-side independently of the client
    - _Requirements: R22.7_
  - [ ] 23.4 Sweep for swallowed errors: every catch either logs and records an outcome or rethrows
    - _Requirements: R23.3, R23.4_
  - [ ] 23.5 Verify the frontend surfaces every error class actionably, including a backend-unreachable state with retry
    - _Requirements: R23.5, R23.6_
  - [ ] 23.6 Confirm the disclaimers appear on every risk-score surface and that no copy claims clinical validity
    - _Requirements: R22.1, R22.2, R22.3, R3.7_

- [ ] 24. Demo polish
  - _Depends on: 23_
  - [ ] 24.1 Confirm the dashboard conveys job state, progress, online activity, conflicts, recovery, and final proof without navigation
    - _Requirements: R24.1_
  - [ ] 24.2 Audit animations: every transition maps to a real state change; remove any spinner or progress motion not bound to simulation state
    - _Requirements: R24.3_
  - [ ] 24.3 Measure the full scripted demo duration, tune the default speed into the documented presentation window, and record the measured number
    - _Requirements: R24.4_
  - [ ] 24.4 Accessibility pass: contrast, keyboard focus, `aria-label` on icon-only buttons, no state conveyed by color alone
    - _Requirements: R24.6_
  - [ ] 24.5 Confirm the primary call to action is above the fold on first load
    - _Requirements: R24.5_

- [ ] 25. Documentation
  - _Depends on: 24_
  - [ ] 25.1 Write `README.md` covering all thirteen R25.1 sections, including the exact run and test commands and the healthcare disclaimer
    - _Requirements: R25.1_
  - [ ] 25.2 Write `docs/architecture.md`: layers, ports and adapters, data model, event flow, why `version` means source-data version
    - _Requirements: R25.2, R25.3_
  - [ ] 25.3 Write `docs/backfill-algorithm.md`: per-record algorithm, guarded write, conflict and re-evaluation loop, recovery boundary derivation, verification checks and what each would catch
    - _Requirements: R25.2, R25.3_
  - [ ] 25.4 Write `docs/demo-script.md`: timed narration a presenter can read verbatim, with the measured duration per beat
    - _Requirements: R25.2, R25.4_
  - [ ] 25.5 Final pass reconciling documentation with actual behavior
    - _Requirements: R25.5_

- [ ] 26. Definition-of-done verification
  - _Depends on: 25_
  - [ ] 26.1 On a clean checkout, run install → seed → `RUN WINNING DEMO` and confirm the full DoD sequence from requirements §8 executes
  - [ ] 26.2 Confirm the final output reads Coverage = 100%, Missed Records = 0, Stale Overwrites = 0, Lost Online Updates = 0, STATUS = VERIFIED SAFE, with every number traced back to persisted state
  - [ ] 26.3 Confirm the naive comparison on the same scenario reports `staleOverwrites > 0` and `lostOnlineUpdates > 0`
  - [ ] 26.4 Confirm the full test suite passes from one root command
    - _Requirements: All_

---

## Critical path

```
1 → 2 → 3 → 4 → 5 → 7 → 8 → 9 → 10 → 11 → 12 → 19 → 26
```

Tasks 6 and 13 branch off task 5. Frontend tasks 14–18 depend only on 13 and can proceed in parallel
with 19–21 once the engine is correct. Tasks 22–25 are sequential hardening.

## Gate checks

Do not advance past these without the stated evidence:

| Gate | Evidence required |
|---|---|
| After 1 | Both servers boot; frontend reaches backend health |
| After 3 | Boundary tests green; same seed reproduces the dataset |
| After 5 | Uncontended run reaches 100% ledger coverage |
| After 10 | A mid-flight update produces a conflict, a rejection, and a correct re-evaluation |
| After 11 | Verification demonstrably **fails** on injected corruption |
| After 12 | Naive shows stale overwrites, guarded shows zero, same scenario |
| After 19 | Scenario run twice is identical |
| After 26 | Full DoD sequence and suite green on a clean checkout |
