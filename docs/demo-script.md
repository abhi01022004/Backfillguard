# Demo script

> All patient data in this project is randomly generated. The risk score is an invented formula with no
> clinical meaning. See the [healthcare disclaimer](../README.md#healthcare-disclaimer).

A timed narration a presenter can follow verbatim. Two versions: a **three-minute** run for a judging slot,
and a **six-minute** run when there is time for questions.

---

## Before you start

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Open **http://localhost:5173**. Check three things:

1. The header shows **Backend connected**.
2. The dashboard shows **1,000** total patients.
3. The **RUN DEMO** button is enabled.

Press **Reset simulation** if a previous run is on screen. The scripted demo resets on its own, so this is
belt and braces.

**Measured timing:** the scripted demo takes **11.6–12.3 seconds** end to end on the default 1,000-record
dataset (three consecutive measured runs: 12.3s, 11.9s, 11.6s). All three produced the identical
eleven-patient conflict set. Budget 15 seconds of silence and narrate over it.

---

## The three-minute version

### 0:00 — 0:25 · The problem

> "A hospital needs to add a computed risk score to every one of a million patient records. That takes hours.
> Meanwhile doctors, nurses and labs are editing those same records — you cannot take the system offline.
>
> So here is the failure mode. The backfill reads a patient, computes a score from their glucose reading, and
> a second later a lab files a new glucose value. When the backfill writes, it writes a score based on data
> that no longer exists — and if it saves the whole record, it reverts the lab result too. The new reading is
> gone from the chart.
>
> BackfillGuard makes one guarantee: **every record is eventually considered, and no newer clinical update is
> ever overwritten by older backfill data.** And it proves it rather than claiming it."

*Point at the disclaimer banner:* "All synthetic data, invented scoring formula, not for clinical use."

### 0:25 — 0:40 · Start the demo

*Press **RUN DEMO**.*

> "One click runs the whole thing: start the backfill, let clinical staff collide with it, crash it mid-batch,
> destroy its checkpoint, recover, and audit the result. Twelve seconds. Every step fires on a record count,
> not a timer, so this run is reproducible — same seed, same conflicts, same numbers."

### 0:40 — 1:10 · Watch it run

*Let it run. Narrate over the step tracker as steps light up.*

> "Records are being scored partition by partition — the grid shows each one's state.
>
> There: **Lab result lands mid-computation.** A glucose reading arrived for a patient the backfill had read
> but not yet written. Watch the conflict list on the right."

*A conflict card appears.*

> "That card is the whole argument. Backfill read version 2. The database is at version 3. Glucose moved
> 118 to 210. The score computed from the old value was **48** and it was **refused** — the write carried a
> version predicate, the database matched zero rows, and nothing landed. Then it recomputed from the current
> reading and got **63**.
>
> And look at that line: the risk level moved from **MEDIUM** to **HIGH**. The stale value would have filed
> this patient a band lower. That is not a different number — it is a different clinical picture."

### 1:10 — 1:35 · The crash

*The crash step fires. The badge goes to **Crashed**.*

> "The process just died with a batch of results computed but not yet written. Those are frozen — staged
> durably, so they survived the process. No committed patient data was touched.
>
> Now, during the outage, a nurse updates one of those frozen patients. So one of those staged results is now
> provably stale. That is exactly what a naive resume would write.
>
> And then — **destroy the checkpoint.** The job no longer knows where it stopped."

*Point at the checkpoint panel:* "Active checkpoint: none. Last known position is shown for narration only —
recovery is not allowed to use it."

### 1:35 — 2:05 · Recovery

> "Recovery derives its position from the data, not from a cursor. It asks the database: which records already
> carry a score computed from the version they currently hold? The first partition where that is not true is
> where it resumes.
>
> Two things fall out of that. First, losing the checkpoint costs nothing. Second — and this is the better
> argument — the boundary can move *backwards*. If a clinician edited a record in an early partition, that
> record's score is now older than its data, so recovery goes back for it. A cursor would have skipped it
> forever.
>
> And notice the recovery summary separates **left untouched** from **reprocessed**. Records already correct
> were not rewritten. That is the evidence it reasoned about the data rather than blindly redoing work."

### 2:05 — 2:40 · The proof

*The verdict banner turns green.*

> "**VERIFIED SAFE.** And this is the part that matters: that verdict comes from a separate engine that takes
> only the database and the ledgers. It receives no counter from the backfill. The code that did the writing
> does not grade its own work.
>
> Stale overwrites: **zero** — measured from the write ledger, not from a counter.
> Lost clinical updates: **zero** — every online update replayed and checked field by field.
> Coverage: **100 percent** — a set difference between all patient ids and the consideration ledger, not a
> counter comparison.
> Stale writes blocked: **eleven** — the guard actually fired, so this run tested the mechanism.
>
> Six independent checks, each shown with the method it used, so you can judge whether it is really
> independent."

*Optional, if a judge looks sceptical:* "And each of those checks has a test that deliberately breaks the
invariant and asserts the verdict flips. A check that cannot fail proves nothing."

### 2:40 — 3:00 · The comparison

*Navigate to **Comparison**, press **Run comparison**.*

> "Same scenario, same data, two engines — differing only in whether the write carries a version predicate.
>
> The naive engine: **stale overwrite detected**, three clinical updates lost. Patient P0051's glucose went
> back from 272 to 102. The lab result is gone.
>
> BackfillGuard: **prevented**. 272 preserved.
>
> One row worth pausing on: **internally inconsistent rows — zero for both.** The naive engine reverted the
> value and then rescored from the reverted value, so its rows agree with themselves while being wrong. A
> consistency check would pass this run. That is exactly why safety has to be measured against the write
> ledger rather than inferred from the final state."

---

## The six-minute version

Everything above, plus these four insertions.

### After the first conflict card — the version model *(45 seconds)*

*Navigate to **Patients**, click the conflicted patient's code.*

> "Here is that patient's full history, and every line is read back from a different table.
>
> The lab's update comes from the online-update log. The blocked write comes from the write ledger. The
> conflict and its resolution come from the conflict table. The 'left untouched' entry comes from the
> consideration ledger. Nothing here is narration — it is four independent records placed in order.
>
> And this column" — *point at **Version / scored*** — "is the whole design in one place. First number is the
> source data's version. Second is the version the stored score was computed from. When they match, that score
> describes the data the record currently holds.
>
> That works because `version` is incremented *only* by clinical updates. The backfill never touches it. If
> the backfill bumped it too — which is what most optimistic-locking examples do — the two numbers would
> always match right after a write and the comparison would be meaningless."

### Before pressing crash — the manual controls *(45 seconds)*

*Pause the run. Press **Lab files a result**.*

> "You do not have to trust the script. These target a record the backfill has read but not yet written,
> which is the only window where an update can actually make a computed result stale.
>
> Notice the controls that are greyed out tell you why — hover one. Those rules come from the same state
> machine the server enforces, so the interface never offers you something the server would refuse."

*Resume.*

### After the verdict — export *(30 seconds)*

*On the **Verification** page.*

> "Export as JSON for a machine, or print to PDF — the print stylesheet strips the interface chrome and keeps
> the verdict. No PDF library bundled; the browser already renders this page correctly."

### At the end — determinism and limits *(60 seconds)*

*Press **RUN DEMO** again.*

> "Same eleven patients conflict. Same scores. That is not luck — the dataset is regenerated from the seed and
> every random stream is reset, so a repeated run is a genuine replay rather than a fresh run with the same
> settings.
>
> On what is real and what is simulated: the patients, the scoring formula, the clinical traffic and the crash
> button are simulated. The version-guarded write, the durable staging table, the evidence-based recovery
> boundary, the coverage ledger and the independent audit are ordinary engineering that would transfer
> unchanged.
>
> What it does not have: no auth, no multi-process coordination, and SQLite rather than Postgres — the
> predicate is identical but the isolation characteristics would want re-testing. Those are in the README."

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Demo button disabled, "dataset is empty" | Not seeded | `npm run db:seed` |
| "Backend disconnected" banner | Backend not running | `npm run dev:backend`; check port 4000 |
| Demo reports steps as **skipped** | Dataset too small for the step triggers | Reseed at 100 records or more |
| No conflicts recorded | Update frequency set to 0 | Reset, then start with the default settings |
| Verification refused with a 409 | Job has not settled | Wait for **Completed**, then run the audit |
| Numbers frozen but no error | Live socket dropped | The banner says so; press **Request fresh snapshot** |

**Recovery from a wedged state, at any time:** press **Reset simulation**. It is permitted from every state by
design and keeps the dataset, so you can start the demo again immediately.

---

## The numbers to quote

From the measured runs on the default 1,000-record dataset. Conflict counts vary with the dataset and
settings, so quote your own screen — but these are representative.

| Metric | Value |
|---|---|
| Records | 1,000 across 10 partitions |
| Demo duration | 11.6 – 12.3 s |
| Conflicts detected and re-evaluated | 11 |
| Stale writes blocked | 11 |
| **Stale overwrites** | **0** |
| **Lost clinical updates** | **0** |
| **Coverage** | **100%** |
| Checks passed | 6 of 6 |
| Naive engine, same scenario | 3 stale overwrites, 3 lost updates, `VERIFICATION_FAILED` |
| Tests | 506 (396 backend, 110 frontend) |
