# BackfillGuard

**Safe Concurrent Healthcare Data Backfill** — a synthetic simulation of how to backfill a derived
field across a large patient dataset while clinical staff keep editing the same records, survive a
crash that destroys the job's checkpoint, and prove afterwards that nothing newer was overwritten.

> ### Healthcare disclaimer
> Every patient record in this project is randomly generated. The "Patient Risk Score" is an invented
> formula built to demonstrate data-migration safety. It has **no clinical meaning**, it is **not** a
> clinical decision-support system, and it must never be used for any medical purpose. No real or
> re-identifiable patient information is present anywhere in this repository.

---

## The guarantee being demonstrated

> Every eligible patient record is eventually considered, while no newer legitimate online update is
> overwritten by stale backfill data.

Both halves are measured from persisted state by an independent verifier, not asserted by the engine
that did the work:

- **Liveness** — `consideredRecords == eligibleRecords`, `missedRecords == 0`
- **Safety** — `staleOverwrites == 0`, `lostOnlineUpdates == 0`

A deliberately unsafe "naive backfill" runs the same scenario on the same data and fails both, which
is how we show the safety mechanism is load-bearing rather than decorative.

---

## Status

Under active construction. The specification is complete and implementation is proceeding task by
task.

| Phase | Scope | State |
|---|---|---|
| A | Foundation: workspaces, shared contract, API skeleton, logging, errors | Done |
| B | Database, synthetic dataset, repository adapters, risk calculator | Done |
| C | Backfill engine, version control, conflict re-evaluation | Done |
| C | Checkpoints, crash, recovery, verification, naive comparison | Next |
| D | Real-time event stream and dashboard | Planned |
| E | One-click demo, naive comparison, verification report | Planned |
| F | Test suite, security audit, polish, documentation | Planned |

The full specification lives in [`.kiro/specs/backfillguard/`](.kiro/specs/backfillguard/):
[requirements](.kiro/specs/backfillguard/requirements.md) ·
[design](.kiro/specs/backfillguard/design.md) ·
[tasks](.kiro/specs/backfillguard/tasks.md)

This README is expanded into the full document required by R25.1 in task 25.

---

## Running it

Requires Node.js 22.12 or newer.

```bash
npm install                       # also generates the Prisma client
npm run db:migrate                # create the SQLite schema
npm run db:seed                   # generate 1,000 synthetic patients
npm run dev
```

- Frontend: http://localhost:5173
- Backend:  http://localhost:4000/api/health

The header shows a **Backend connected** badge when the frontend has reached the API, and
`/api/health` reports the patient count once seeded.

### Other commands

| Command | Purpose |
|---|---|
| `npm run dev` | Backend and frontend together |
| `npm run dev:backend` | Backend only |
| `npm run dev:frontend` | Frontend only |
| `npm test` | Full test suite, non-watch |
| `npm run typecheck` | Typecheck every workspace |
| `npm run build` | Typecheck backend, build frontend bundle |
| `npm run db:migrate` | Apply the schema |
| `npm run db:seed` | Regenerate the synthetic dataset |
| `npm run db:reset` | Clear job state and unscore patients, keeping the same dataset |

No `.env` file is needed: the database path is resolved to an absolute location in code, so the
Prisma CLI and the running app can never disagree about which file they are using. See
[`.env.example`](.env.example) for the tunable settings and their bounds.

`db:seed` regenerates patients from a seed; `db:reset` keeps the dataset but returns every record to
an unscored baseline, which is what makes the demo replayable against identical starting data.

---

## Repository layout

```
shared/     Types, enums and simulation bounds shared by both sides (single source of truth)
backend/    Express API + simulation domain (engines, recovery, verification)
frontend/   React dashboard, patient views, comparison and verification report
docs/       Architecture, backfill algorithm, demo script
```

The simulation core lives in `backend/src/domain` and depends on injected ports rather than on
Express, Socket.IO or Prisma, so it runs identically against SQLite or an in-memory dataset. That is
what lets the naive comparison run in isolation and the test suite run without a database.

---

## Technology

React · Vite · TypeScript · Tailwind CSS · Lucide · Recharts · Node.js · Express · SQLite · Prisma ·
Socket.IO · Vitest · React Testing Library
