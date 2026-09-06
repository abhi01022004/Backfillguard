# BackfillGuard — architecture, in pictures

A visual companion to [`architecture.md`](architecture.md). Every diagram below is checked against the real
files; the names in the boxes are the actual classes you can open.

Read it top to bottom. Each diagram answers **one question** and adds a little detail to the one before it.

> **Rendering.** These are [Mermaid](https://mermaid.js.org) diagrams. GitHub renders them inline. In VS Code /
> Kiro, open the Markdown preview.

---

## Contents

1. [The whole system on one page](#1-the-whole-system-on-one-page)
2. [The one rule that shapes everything](#2-the-one-rule-that-shapes-everything)
3. [The thing this project actually exists to do](#3-the-thing-this-project-actually-exists-to-do)
4. [Ports and adapters](#4-ports-and-adapters)
5. [Where notifications hook in](#5-where-notifications-hook-in)
6. [What a run actually does, step by step](#6-what-a-run-actually-does-step-by-step)
7. [The job's life](#7-the-jobs-life)
8. [The database, and what each table proves](#8-the-database-and-what-each-table-proves)
9. [How the screen stays live](#9-how-the-screen-stays-live)
10. [Who checks the work](#10-who-checks-the-work)
11. [How it runs in a container](#11-how-it-runs-in-a-container)

---

## 1. The whole system on one page

If you only look at one diagram, look at this one.

```mermaid
flowchart TB
    subgraph browser["🖥️  BROWSER — React dashboard"]
        direction LR
        UI["Dashboard · Patients<br/>Comparison · Report"]
    end

    subgraph server["⚙️  NODE SERVER"]
        direction TB
        API["<b>API layer</b><br/>Express routers · Zod validation<br/>error envelope"]
        DOMAIN["<b>DOMAIN layer</b> — the simulation<br/>engines · risk scoring · recovery · verification<br/><i>imports no database, no HTTP, no sockets</i>"]
        INFRA["<b>INFRA layer</b> — adapters<br/>Prisma repositories · Socket.IO · demo messaging"]
    end

    DB[("🗄️  SQLite<br/>10 tables")]

    UI -- "HTTP requests<br/>(start, pause, crash, verify)" --> API
    API --> DOMAIN
    DOMAIN -- "talks only to<br/><b>ports</b> (interfaces)" --> INFRA
    INFRA --> DB
    INFRA -. "live push over Socket.IO<br/>(progress, events, alerts)" .-> UI

    style browser fill:#eef2ff,stroke:#6366f1
    style server fill:#f0fdf4,stroke:#16a34a
    style DOMAIN fill:#dcfce7,stroke:#15803d,stroke-width:3px
    style DB fill:#fef3c7,stroke:#d97706
```

**In words.** You click a button. The API validates the request and hands it to the domain. The domain contains
all the actual logic and is deliberately ignorant of *how* anything is stored or delivered — it only knows a set
of interfaces. Infra supplies the real implementations. Results flow back to the screen by a live push, not by
the browser polling.

**Why the domain box is outlined.** It is the part worth reading. Everything else is plumbing.

---

## 2. The one rule that shapes everything

Arrows point in the direction of *"depends on"*. Notice that **nothing points into the domain**.

```mermaid
flowchart LR
    API["api/<br/><small>Express routers</small>"] --> DOMAIN
    INFRA["infra/<br/><small>Prisma · Socket.IO · demo provider</small>"] --> DOMAIN
    DOMAIN["<b>domain/</b><br/><small>the simulation</small>"] --> SHARED["shared/<br/><small>types · enums · bounds</small>"]
    API --> SHARED
    INFRA --> SHARED
    FE["frontend/<br/><small>React</small>"] --> SHARED

    style DOMAIN fill:#dcfce7,stroke:#15803d,stroke-width:3px
    style SHARED fill:#e0e7ff,stroke:#4f46e5
```

**Why this matters, in plain terms.** The domain cannot import Prisma, Express or Socket.IO. That is not
tidiness for its own sake — it buys three concrete things:

| Because the domain depends on nothing… | you get |
|---|---|
| the same engines run against a real database *or* plain in-memory objects | tests need no database and run in seconds |
| the naive "broken" engine can run beside the safe one, in one process | an honest side-by-side comparison |
| swapping SQLite for Postgres touches only `infra/` | no logic changes, so no new bugs in the logic |

`shared/` sits underneath everyone. It holds the types, the enums and the risk-band boundaries, so the frontend
and backend physically cannot disagree about what `HIGH` means.

---

## 3. The thing this project actually exists to do

Everything above is scaffolding for this one idea.

**The problem.** Scoring a patient takes time. You read the record, compute a score, then write it back. If a
doctor edits that record *in between*, your score describes data that no longer exists — and writing it would
silently destroy the doctor's edit.

```mermaid
sequenceDiagram
    autonumber
    participant D as 👩‍⚕️ Doctor
    participant B as Backfill engine
    participant DB as 🗄️ Database

    B->>DB: read patient P0221
    DB-->>B: glucose 110, <b>version 1</b>
    Note over B: computes risk score 78<br/>based on version 1

    D->>DB: update glucose → 130
    DB-->>D: saved, <b>version 2</b>

    rect rgb(255, 235, 235)
    Note over B,DB: ⚠️ the engine's score is now STALE
    end

    B->>DB: write score 78 <b>ONLY IF version is still 1</b>
    DB-->>B: ❌ refused — 0 rows matched
    Note over B: version guard fired.<br/>Doctor's edit survives.

    B->>DB: re-read P0221
    DB-->>B: glucose 130, version 2
    Note over B: recomputes → 83
    B->>DB: write score 83 <b>ONLY IF version is still 2</b>
    DB-->>B: ✅ applied
```

**The whole trick is step 7:** the write carries a condition. `UPDATE … WHERE id = ? AND version = ?`. If
someone moved the record, zero rows match, and the database itself refuses. Safety does not depend on the
engine remembering to check.

### Safe vs naive, side by side

The project ships a deliberately broken engine so the difference is demonstrated, not just claimed.

```mermaid
flowchart TB
    subgraph naive["❌ NaiveBackfillEngine — how it usually goes wrong"]
        direction TB
        N1["read record"] --> N2["compute score"] --> N3["write the <b>whole row</b> back<br/>no condition"]
        N3 --> N4["🩸 doctor's edit erased<br/>score describes deleted data"]
    end

    subgraph guarded["✅ BackfillEngine — BackfillGuard"]
        direction TB
        G1["read record"] --> G2["compute score"] --> G3["write <b>derived fields only</b><br/>WHERE version = the one we read"]
        G3 --> G4{"rows<br/>matched?"}
        G4 -- "1" --> G5["✅ applied"]
        G4 -- "0" --> G6["conflict logged<br/>→ recompute from current data"]
        G6 --> G3
    end

    style naive fill:#fef2f2,stroke:#dc2626
    style guarded fill:#f0fdf4,stroke:#16a34a
    style N4 fill:#fecaca,stroke:#dc2626
    style G5 fill:#bbf7d0,stroke:#16a34a
```

Two differences, both essential:

- **The condition** (`WHERE version = …`) — turns a silent overwrite into a refusal you can react to.
- **Writing only the derived fields** — the naive engine writes the whole row it read, which is what physically
  reverts the clinical value.

---

## 4. Ports and adapters

A **port** is an interface the domain defines: *"I need something that can do this."* An **adapter** is a
concrete implementation. The domain never learns which one it got.

```mermaid
flowchart LR
    subgraph dom["DOMAIN defines the need"]
        direction TB
        P1["PatientRepository"]
        P2["JobRepository"]
        P3["EventSink"]
        P4["NotificationRepository"]
        P5["WhatsAppProvider"]
    end

    subgraph real["INFRA — used when running for real"]
        direction TB
        A1["PrismaPatientRepository"]
        A2["PrismaJobRepository"]
        A3["BufferedDbEventSink<br/>+ LiveEventBroadcaster"]
        A4["PrismaNotificationRepository"]
        A5["DemoWhatsAppProvider"]
    end

    subgraph mem["INFRA — used in tests & comparison"]
        direction TB
        B1["InMemoryPatientRepository"]
        B2["InMemoryJobRepository"]
        B3["InMemoryEventSink"]
        B4["InMemoryNotificationRepository"]
    end

    P1 --> A1
    P2 --> A2
    P3 --> A3
    P4 --> A4
    P5 --> A5
    P1 -.-> B1
    P2 -.-> B2
    P3 -.-> B3
    P4 -.-> B4

    style dom fill:#dcfce7,stroke:#15803d
    style real fill:#fef3c7,stroke:#d97706
    style mem fill:#e0e7ff,stroke:#4f46e5
```

**The catch this design creates, and how it is handled.** Two implementations of one interface can drift apart —
and if the in-memory one is more forgiving than SQLite, every passing test stops meaning anything about the
real system.

So both are run against **one shared contract suite** (`repositoryContract.ts`, `notificationContract.ts`). The
same assertions, both adapters. They cannot disagree without a test failing.

---

## 5. Where notifications hook in

Requirement: send a WhatsApp alert for high-risk patients — but **never** for a score that turned out to be
stale.

The naive approach is to add a "send alert" call inside each engine. There are four places that commit a score,
so that is four chances to forget one, and the easiest to forget is the recovery path, where a stale alert is
hardest to notice.

Instead, note that **every safe commit already goes through one method**: `applyGuarded`. So wrap that.

```mermaid
flowchart TB
    E1["BackfillEngine<br/><small>first pass</small>"] --> DEC
    E2["ConflictEngine<br/><small>after a collision</small>"] --> DEC
    E3["RecoveryEngine<br/><small>after a crash</small>"] --> DEC

    DEC["<b>NotifyingPatientRepository</b><br/><small>a wrapper — watches every guarded write</small>"]
    DEC --> REAL["PrismaPatientRepository<br/><small>does the actual write</small>"]
    DEC --> SVC["NotificationService<br/><small>decides if an alert is warranted</small>"]
    SVC --> PROV["DemoWhatsAppProvider<br/><small>simulates the send</small>"]
    REAL --> DB[("🗄️ SQLite")]
    SVC --> DB

    NAIVE["NaiveBackfillEngine"] -- "uses applyUnguardedWholeRow<br/>— never reaches the wrapper" --> REAL

    style DEC fill:#dbeafe,stroke:#2563eb,stroke-width:3px
    style NAIVE fill:#fef2f2,stroke:#dc2626
    style SVC fill:#dcfce7,stroke:#15803d
```

**Four things this buys, for free:**

1. **No engine was modified.** The concurrency logic — the part that must stay correct — carries no alert code.
2. **All three commit paths are covered at once**, including any added later.
3. **The broken engine is excluded automatically**, because it writes through a different method.
4. It is **opt-in**: only the app wires the wrapper, so tests get a plain repository.

### An alert's life

```mermaid
stateDiagram-v2
    direction LR
    [*] --> QUEUED : HIGH score computed<br/>(not yet written)
    QUEUED --> SENT : write applied ✅<br/>version still matched
    QUEUED --> CANCELLED : write refused ❌<br/>or superseded by a newer commit
    SENT --> [*]
    CANCELLED --> [*]
    SENT --> FAILED : provider rejected it
    FAILED --> [*]

    note right of QUEUED
        Nothing is transmitted in this state.
        A crash here therefore sends nothing.
    end note
    note right of CANCELLED
        This is the feature working.
        Kept on record so a prevented
        alert is visible, not just absent.
    end note
```

**Why keep cancelled alerts?** Deleting them would be simpler and equally safe — and it would make the safety
mechanism invisible. You would only ever see an *absence* and be asked to trust it. A `CANCELLED` row names the
patient, the stale version, and the version that replaced it. You can point at it.

---

## 6. What a run actually does, step by step

```mermaid
flowchart TB
    START(["▶ Start"]) --> LOOP

    subgraph LOOP["one tick, repeated"]
        direction TB
        R["read a batch of patients"] --> C["compute risk scores<br/><small>pure function, no I/O</small>"]
        C --> S["<b>stage</b> results in a table<br/><small>so a crash cannot lose them</small>"]
        S --> W["write each one<br/><small>guarded by version</small>"]
        W --> OK{"applied?"}
        OK -- yes --> LEDGER["record in ledgers<br/><small>the evidence trail</small>"]
        OK -- "no — someone edited it" --> CONF["log conflict<br/>→ recompute → retry"]
        CONF --> W
        LEDGER --> CP{"checkpoint<br/>due?"}
        CP -- yes --> SAVE["save progress"]
        CP -- no --> NEXT["next batch"]
        SAVE --> NEXT
    end

    LOOP --> DONE{"all records<br/>considered?"}
    DONE -- no --> LOOP
    DONE -- yes --> VERIFY["🔍 independent verification"]
    VERIFY --> RESULT(["VERIFIED SAFE<br/>or VERIFICATION FAILED"])

    style C fill:#e0e7ff,stroke:#4f46e5
    style W fill:#dcfce7,stroke:#15803d,stroke-width:2px
    style CONF fill:#fef3c7,stroke:#d97706
    style VERIFY fill:#dbeafe,stroke:#2563eb
```

**Why "stage" is a separate step (box 3).** Results live in a database table between being computed and being
written. If they lived only in memory, a crash would lose them — and then the crash-recovery story would be
untestable, because there would be nothing stale left over to *be* refused. Staging is what makes the crash
scenario real.

### Surviving a crash

```mermaid
sequenceDiagram
    autonumber
    participant J as Backfill job
    participant DB as 🗄️ Database
    participant N as 👩‍⚕️ Nurse

    J->>DB: stage results for 20 patients
    Note over J: 💥 process dies here
    Note over DB: staged results survive.<br/>Checkpoint also deleted — job<br/>no longer knows where it stopped.

    N->>DB: updates one of those 20 patients
    DB-->>N: saved, version bumped

    Note over J: 🔄 restart
    J->>DB: which records already have a score<br/>from their <b>current</b> version?
    DB-->>J: these are provably done — skip
    Note over J: resume point derived from the DATA,<br/>not from a remembered position

    J->>DB: try to flush the 20 staged results
    DB-->>J: 19 applied ✅ · 1 refused ❌ (the nurse's patient)
    J->>DB: recompute that one, write at new version
    DB-->>J: ✅ applied
```

**The point of destroying the checkpoint.** A checkpoint is an optimisation, not a source of truth. Recovery
works out where to resume by *reading the data* — which records already carry a score computed from their
current version. That means correctness does not depend on remembering anything.

---

## 7. The job's life

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> RUNNING : start
    RUNNING --> PAUSED : pause
    PAUSED --> RUNNING : resume
    RUNNING --> CRASHED : 💥 crash (demo button)
    CRASHED --> RECOVERING : recover
    RECOVERING --> COMPLETED
    RUNNING --> COMPLETED : all records considered
    COMPLETED --> VERIFYING : verify
    VERIFYING --> VERIFIED_SAFE : all 6 checks passed
    VERIFYING --> VERIFICATION_FAILED : a check failed
    RUNNING --> FAILED : unrecoverable
    VERIFIED_SAFE --> [*]
    VERIFICATION_FAILED --> [*]
    FAILED --> [*]
```

These transitions live in one table in `shared/`, so the backend and the buttons in the UI use the same rules —
the UI cannot offer an action the server would reject.

---

## 8. The database, and what each table proves

```mermaid
erDiagram
    Patient ||--o{ OnlineUpdate : "edits by staff"
    Patient ||--o{ Notification : "risk alerts"
    Patient ||--o{ ConsiderationLedger : "was I looked at?"
    Patient ||--o{ WriteLedger : "every write attempt"
    Patient ||--o{ Conflict : "collisions"
    Patient ||--o{ PendingResult : "computed, not yet written"
    BackfillJob ||--o{ Checkpoint : "resume hints"
    BackfillJob ||--o{ EventLog : "timeline"
```

| Table | Its job | What it lets you prove |
|---|---|---|
| **Patient** | the records being backfilled | — |
| **OnlineUpdate** | every clinical edit made by staff | no edit was lost *(the key check)* |
| **PendingResult** | scores computed but not yet written | a crash had something stale to refuse |
| **WriteLedger** | every write **attempt**, applied or refused | no stale write ever landed |
| **ConsiderationLedger** | the final decision per record | every record was looked at |
| **Conflict** | detected collisions + how each was resolved | none was abandoned |
| **Checkpoint** | progress hints | (deliberately destroyed in the demo) |
| **Notification** | risk alerts and their fate | no alert fired on stale data |
| **EventLog** | the human-readable timeline | what happened, in order |
| **BackfillJob** | one migration run | — |

**The idea behind the ledgers.** They are not logs for debugging. They are *evidence*, written so that a
separate program can later re-derive every claim without trusting the engine that made it.

---

## 9. How the screen stays live

```mermaid
flowchart LR
    ENGINE["engine emits<br/>an event"] --> SINK["EventSink"]
    SINK --> DBW[("EventLog table<br/><small>durable</small>")]
    SINK --> BC["LiveEventBroadcaster"]

    BC -- "<b>snapshot</b><br/>once, on connect" --> UI
    BC -- "<b>event</b><br/>each significant moment" --> UI
    BC -- "<b>jobState</b><br/>throttled progress" --> UI

    UI["🖥️ Dashboard"]

    style BC fill:#dbeafe,stroke:#2563eb
    style DBW fill:#fef3c7,stroke:#d97706
```

Three channels, on purpose:

- **`snapshot`** — a late-joining viewer gets the current state immediately, instead of an empty screen slowly
  filling in.
- **`event`** — individual moments worth seeing (a conflict, a crash, an alert).
- **`jobState`** — progress, deliberately throttled. A 1,000-record run changes progress thousands of times;
  pushing each one would flood the socket to redraw the same bar.

The browser never polls, and nothing on screen is a local guess — every number came from the server, so two
people watching see the same thing.

---

## 10. Who checks the work

An engine reporting its own success is worth very little. So verification is a **separate** engine that is
handed the repositories and nothing else — no counters, no engine instance.

```mermaid
flowchart TB
    subgraph V["VerificationEngine — grades from evidence only"]
        direction TB
        C1["C1 · every record considered<br/><small>set difference vs the ledger</small>"]
        C2["C2 · no stale write landed<br/><small>scan the write ledger</small>"]
        C3["C3 · no clinical edit lost<br/><small>replay every edit, field by field</small>"]
        C4["C4 · stored scores recompute correctly<br/><small>redo the arithmetic</small>"]
        C5["C5 · scores valid and in range"]
        C6["C6 · every conflict resolved"]
    end

    LEDGERS[("ledgers · conflicts<br/>edits · patients")] --> V
    V --> VERDICT{"all six<br/>passed?"}
    VERDICT -- yes --> SAFE["✅ VERIFIED SAFE"]
    VERDICT -- no --> FAIL["❌ VERIFICATION FAILED<br/><small>names the exact records</small>"]

    V -.-> ADV["📱 notification advisory<br/><small>stale / duplicate alerts</small><br/><b>does NOT affect the verdict</b>"]

    style C3 fill:#fef3c7,stroke:#d97706,stroke-width:2px
    style SAFE fill:#bbf7d0,stroke:#16a34a
    style FAIL fill:#fecaca,stroke:#dc2626
    style ADV fill:#f1f5f9,stroke:#94a3b8,stroke-dasharray: 5 5
```

**Why C3 is highlighted.** It is the only check that catches the naive engine. C4 actually *passes* for a naive
run: the engine reverts the clinical value and then scores the reverted value, so the row is internally
consistent — the score and the data agree, and both are wrong. Only replaying the edits reveals it.

**Why the notification advisory is dashed and off to the side.** The verdict is a statement about *patient
data*. If a fault in a demo messaging simulator could turn `VERIFIED SAFE` red, a reader would reasonably
conclude patient data had been corrupted when it had not. It is measured, and reported loudly if wrong — but it
is kept out of the verdict so `VERIFIED SAFE` keeps a precise meaning.

**Falsifiability.** Each check has a test that deliberately breaks the thing it checks and asserts the verdict
flips. "Zero stale overwrites" is only meaningful because a non-zero result is reachable.

---

## 11. How it runs in a container

`docker compose up --build`, then http://localhost:8080.

```mermaid
flowchart TB
    USER["🖥️ Your browser<br/>localhost:8080"]

    subgraph net["docker compose network"]
        direction TB

        subgraph fe["frontend container — nginx"]
            NGINX["nginx<br/>serves the built SPA<br/>proxies /api and /live"]
            STATIC[["static files<br/>index.html · /assets/*"]]
        end

        subgraph be["backend container — node"]
            APP["Express + Socket.IO<br/>:4000<br/><i>not published</i>"]
        end

        VOL[("named volume<br/>backfillguard-data<br/><small>the SQLite file</small>")]
    end

    USER -- ":8080" --> NGINX
    NGINX --> STATIC
    NGINX -- "/api → HTTP" --> APP
    NGINX -- "/live → websocket upgrade" --> APP
    APP --> VOL

    style fe fill:#eef2ff,stroke:#6366f1
    style be fill:#f0fdf4,stroke:#16a34a
    style VOL fill:#fef3c7,stroke:#d97706
    style USER fill:#f1f5f9,stroke:#94a3b8
```

**Only one container is published.** The backend's port 4000 is reachable only from inside the compose network.
Nothing outside needs it, and exposing it would invite the dashboard to be pointed at a different origin than the
one it was built for.

**Why nginx and not Express serving the bundle.** The backend serves no static assets by design; adding that
would mean changing application code to suit the packaging. nginx also reproduces the Vite dev proxy exactly —
same-origin `/api` and `/live` — so the app behaves identically in development and in a container, and no CORS
preflight ever happens.

**The websocket upgrade is explicit.** nginx sets `Upgrade` and `Connection` on `/live`. Without them Socket.IO
silently falls back to HTTP long-polling: the dashboard still works, just less promptly and with far more
requests — the sort of degradation nobody notices until a demo feels sluggish.

### What happens on container start

```mermaid
flowchart LR
    START(["container starts"]) --> CHECK{"database file<br/>already there?"}
    CHECK -- "no — new volume" --> MIG1["apply migrations"] --> SEED["seed 1,000 patients"] --> RUN
    CHECK -- "yes" --> MIG2["apply migrations<br/><small>no-op if current</small>"] --> SKIP["skip seeding"] --> RUN
    RUN["exec the server<br/><small>becomes PID 1</small>"] --> READY(["healthy · accepting traffic"])

    style SEED fill:#dcfce7,stroke:#15803d
    style SKIP fill:#fef3c7,stroke:#d97706
    style READY fill:#bbf7d0,stroke:#16a34a
```

**Seeding only happens on a new volume, and that matters.** Seeding calls `replaceAll`, which is destructive.
Doing it on every boot would silently wipe a completed run every time the container restarted — and the wipe
would look like data loss rather than a seed. Presence of the database file is the signal that this volume has
been initialised before.

**`exec` on the last step is deliberate.** It replaces the entrypoint shell so the server becomes PID 1 and
receives `SIGTERM` directly from `docker stop`. Otherwise the signal stops at the script and the graceful
shutdown — which flushes buffered events to the durable log — never runs.

---

## Putting it together — one request, end to end

```mermaid
sequenceDiagram
    autonumber
    participant U as 🖥️ You
    participant API as Express router
    participant O as SimulationOrchestrator
    participant E as BackfillEngine
    participant R as Repository (guarded)
    participant DB as 🗄️ SQLite
    participant S as Socket.IO

    U->>API: POST /api/backfill/start
    API->>API: validate body · check state transition is legal
    API->>O: start()
    O-->>API: accepted
    API-->>U: 200 (returns immediately)

    loop every tick, in the background
        O->>E: processNextBatch()
        E->>R: read · stage · applyGuarded
        R->>DB: UPDATE … WHERE version = ?
        DB-->>R: applied / refused
        R-->>E: outcome
        E->>S: emit events
        S-->>U: live push → screen updates
    end
```

The request returns immediately and the work continues in the background, reporting over the socket. Holding
the HTTP request open for a run that takes ~19 seconds would risk a proxy timeout killing it halfway.

---

## Where to look in the code

| To understand… | Open |
|---|---|
| the safe write itself | `backend/src/infra/repositories/PrismaPatientRepository.ts` → `applyGuarded` |
| the tick loop and job lifecycle | `backend/src/domain/orchestrator/SimulationOrchestrator.ts` |
| conflict handling | `backend/src/domain/engine/ConflictEngine.ts` |
| crash recovery | `backend/src/domain/engine/RecoveryEngine.ts` |
| the audit | `backend/src/domain/verify/VerificationEngine.ts` |
| the deliberately broken engine | `backend/src/domain/engine/NaiveBackfillEngine.ts` |
| notifications | `backend/src/infra/repositories/NotifyingPatientRepository.ts` |
| what the domain is allowed to need | `backend/src/domain/ports/` |

Deeper prose on each decision: [`architecture.md`](architecture.md) ·
[`backfill-algorithm.md`](backfill-algorithm.md) · [`demo-script.md`](demo-script.md)

---

> ⚠️ Every patient record here is randomly generated and the risk score is an invented formula with no clinical
> meaning. The WhatsApp alerts are simulated — no message is ever transmitted.
