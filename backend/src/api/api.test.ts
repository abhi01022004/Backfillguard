import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  ACTOR_TYPE,
  BACKFILL_STATUS,
  CLINICAL_BOUNDS,
  DEFAULT_SEED,
  DEFAULT_SIMULATION_SETTINGS,
  DIAGNOSIS,
  ERROR_CODE,
  JOB_STATUS,
  RISK_LEVEL,
  SIMULATION_BOUNDS,
} from '@bg/shared';
import { createApp } from '../app';
import { createSystemClock } from '../lib/clock';
import { createRng } from '../lib/rng';
import { InMemoryEventSink } from '../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../infra/seed/patientGenerator';
import { OnlineUpdateSimulator } from '../domain/online/OnlineUpdateSimulator';
import { SimulationOrchestrator } from '../domain/orchestrator/SimulationOrchestrator';
import { ScenarioManager } from '../domain/scenario/ScenarioManager';
import { InMemoryNotificationRepository } from '../infra/repositories/InMemoryNotificationRepository';
import { NotifyingPatientRepository } from '../infra/repositories/NotifyingPatientRepository';
import { DemoWhatsAppProvider } from '../infra/notification/DemoWhatsAppProvider';
import { NotificationService } from '../domain/notification/NotificationService';

/**
 * The HTTP surface (R1.6, R22.4–R22.8, R23.1–R23.5).
 *
 * ## Why these tests exist separately from the domain suite
 *
 * The domain tests prove the engines are safe. These prove the *boundary* is safe, which is a different
 * claim and fails in different ways. Two properties in particular can only be broken here:
 *
 *  1. **The derived block and version bookkeeping must be unreachable from a client.** The domain validator
 *     enforces it, but a schema that accepted `riskScore` and quietly dropped it would still pass every
 *     domain test while advertising an attack surface. So the assertions below check that such a request is
 *     *rejected*, not merely ineffective.
 *  2. **Every failure must leave as a structured envelope.** A route that throws a bare `Error` produces a
 *     500 with an HTML stack trace, which no client can act on.
 *
 * Built over in-memory repositories, so there is no database, no listening socket and no shared state
 * between cases.
 */

const TOTAL = 40;
const PARTITIONS = 4;

interface Harness {
  app: Express;
  patients: InMemoryPatientRepository;
  orchestrator: SimulationOrchestrator;
  notifications: NotificationService;
}

/**
 * A real clock, deliberately, unlike every other suite in this project.
 *
 * `POST /api/backfill/start` is the production path, so it starts the orchestrator's own paced background
 * loop — and that loop awaits `clock.sleep()`. A manual clock has nothing to advance it, so the loop never
 * completes a single tick and anything that awaits it hangs. The first version of this file used a manual
 * clock and took 48 seconds to fail four tests on request timeouts.
 *
 * Determinism is unaffected: pacing changes how long a run takes, never the order of anything. `backfillSpeed`
 * is pinned to its maximum so the wall-clock cost stays in milliseconds.
 */
async function makeHarness(
  options: { seedData?: boolean; tickDelayMs?: number } = {},
): Promise<Harness> {
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();
  const clock = createSystemClock();
  const events = new InMemoryEventSink(clock, 50_000);
  const rng = createRng(DEFAULT_SEED);

  if (options.seedData ?? true) {
    await patients.replaceAll(
      generatePatients({ totalRecords: TOTAL, partitionCount: PARTITIONS, seed: DEFAULT_SEED }),
    );
  }

  /**
   * The notification stack, wired the same way the composition root wires it.
   *
   * The orchestrator is given the *wrapped* repository, so a backfill driven through the HTTP API produces real
   * notifications by the same mechanism production uses. Building the harness with a plain repository and then
   * testing notifications separately would have left the wiring itself — the part most likely to be wrong —
   * unexercised.
   */
  const notificationStore = new InMemoryNotificationRepository();
  const notifications = new NotificationService({
    notifications: notificationStore,
    provider: new DemoWhatsAppProvider(),
    events,
  });
  const guardedPatients = new NotifyingPatientRepository(patients, notifications);

  const orchestrator = new SimulationOrchestrator({
    patients: guardedPatients,
    jobs,
    events,
    clock,
    rng,
    seed: DEFAULT_SEED,
    settings: {
      ...DEFAULT_SIMULATION_SETTINGS,
      totalRecords: TOTAL,
      partitionCount: PARTITIONS,
      backfillSpeed: SIMULATION_BOUNDS.backfillSpeed.max,
      onlineUpdateFrequency: 0,
      batchSize: 5,
      checkpointInterval: 10,
    },
  });

  const onlineUpdates = new OnlineUpdateSimulator({
    repository: patients,
    events,
    rng: rng.fork('online-updates'),
  });

  const scenarios = new ScenarioManager({
    orchestrator,
    simulator: onlineUpdates,
    repository: patients,
    events,
    clock,
    // Slow enough that a demo is still running when the next request arrives, which is what the
    // "refuses a second demo" case needs to observe.
    tickDelayMs: options.tickDelayMs ?? 0,
    // No dwell: these tests assert HTTP behaviour, not how watchable the demo is.
    stepDwellMs: 0,
  });

  const app = createApp({
    repository: guardedPatients,
    orchestrator,
    onlineUpdates,
    scenarios,
    clock,
    events,
    notifications,
    health: { probeDatabase: async () => ({ connected: true, patientCount: await patients.countAll() }) },
  });

  return { app, patients, orchestrator, notifications };
}

describe('API: health and routing', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('reports health with a real patient count', async () => {
    const response = await request(harness.app).get('/api/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.database).toEqual({ connected: true, patientCount: TOTAL });
  });

  it('returns the standard envelope for an unknown route, not an HTML 404', async () => {
    const response = await request(harness.app).get('/api/does-not-exist').expect(404);

    expect(response.body.error.code).toBe(ERROR_CODE.NOT_FOUND);
    expect(response.body.error.message).toContain('GET /api/does-not-exist');
  });

  it('does not advertise the server implementation', async () => {
    const response = await request(harness.app).get('/api/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('bounds the request body size', async () => {
    // A payload the API can be handed must have a ceiling, or a single request can exhaust memory (R22.8).
    const oversized = { actorType: ACTOR_TYPE.LAB, padding: 'x'.repeat(2 * 1024 * 1024) };

    const response = await request(harness.app).post('/api/online-update').send(oversized);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('API: patient reads', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('paginates with real totals', async () => {
    const response = await request(harness.app)
      .get('/api/patients?page=2&pageSize=10')
      .expect(200);

    expect(response.body.items).toHaveLength(10);
    expect(response.body.total).toBe(TOTAL);
    expect(response.body.totalPages).toBe(4);
  });

  it('filters by status, risk level, partition and free text', async () => {
    const byStatus = await request(harness.app)
      .get(`/api/patients?status=${BACKFILL_STATUS.PENDING}&pageSize=1`)
      .expect(200);
    expect(byStatus.body.total).toBe(TOTAL);

    const byPartition = await request(harness.app)
      .get('/api/patients?partitionIndex=2&pageSize=1')
      .expect(200);
    expect(byPartition.body.total).toBe(TOTAL / PARTITIONS);

    const bySearch = await request(harness.app).get('/api/patients?q=P0007').expect(200);
    expect(bySearch.body.total).toBe(1);
    expect(bySearch.body.items[0].patientCode).toBe('P0007');
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    /**
     * A silently ignored parameter is worse than an error: the caller believes a filter applied and reads the
     * unfiltered result as if it were filtered.
     */
    const response = await request(harness.app).get('/api/patients?limt=10').expect(400);
    expect(response.body.error.code).toBe(ERROR_CODE.VALIDATION_ERROR);
  });

  it('rejects an out-of-range page size and an invalid enum value', async () => {
    await request(harness.app).get('/api/patients?pageSize=5000').expect(400);
    await request(harness.app).get('/api/patients?riskLevel=EXTREME').expect(400);
    await request(harness.app).get('/api/patients?partitionIndex=-1').expect(400);
  });

  it('returns a patient with a live risk breakdown and its history', async () => {
    const response = await request(harness.app).get('/api/patients/P0001').expect(200);

    expect(response.body.patient.patientCode).toBe('P0001');
    expect(response.body.risk.breakdown.length).toBeGreaterThan(0);
    expect(response.body.disclaimer).toMatch(/Not for Clinical Use/);
    // Never scored yet, so "does the stored score match?" has no answer rather than a false one.
    expect(response.body.storedScoreMatchesCurrentData).toBeNull();
    expect(response.body.history).toEqual([]);
  });

  it('rejects a malformed patient code before it reaches storage', async () => {
    // Also the reason a path-traversal attempt cannot get through: the pattern is an allowlist.
    const response = await request(harness.app).get('/api/patients/..%2F..%2Fetc%2Fpasswd');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('reports a missing patient as PATIENT_NOT_FOUND', async () => {
    const response = await request(harness.app).get('/api/patients/P9999').expect(404);
    expect(response.body.error.code).toBe(ERROR_CODE.PATIENT_NOT_FOUND);
    expect(response.body.error.details).toMatchObject({ patient: 'P9999' });
  });

  it('exposes no write path to a patient record', async () => {
    // The only route into clinical data is the online-update simulator, which enforces the whitelist.
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(harness.app)[method]('/api/patients/P0001').send({ glucose: 400 });
      expect(response.status).toBe(404);
    }
  });
});

describe('API: online updates', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('applies a whitelisted change and increments the version by one', async () => {
    const response = await request(harness.app)
      .post('/api/online-update')
      .send({ patientCode: 'P0002', actorType: ACTOR_TYPE.LAB, changes: { glucose: 210 } })
      .expect(200);

    expect(response.body.applied).toBe(true);
    expect(response.body.newVersion).toBe(response.body.previousVersion + 1);
    expect(response.body.changedFields).toEqual([
      { field: 'glucose', from: expect.any(Number), to: 210 },
    ]);
  });

  it('refuses to let a client write the derived block or version bookkeeping', async () => {
    /**
     * The most important assertions in this file (R22.5, R22.6).
     *
     * These four fields are computed server-side, and the schema lists exactly the five clinical fields, so
     * they are structurally unreachable rather than filtered out later. Checking for *rejection* rather than
     * for "no effect" is deliberate: a schema that stripped them would still pass an effect-based test while
     * telling a caller the request succeeded.
     */
    for (const forbidden of [
      { riskScore: 99 },
      { riskLevel: RISK_LEVEL.LOW },
      { version: 1 },
      { lastBackfillVersion: 1 },
      { age: 30 },
    ]) {
      const response = await request(harness.app)
        .post('/api/online-update')
        .send({ patientCode: 'P0002', actorType: ACTOR_TYPE.LAB, changes: forbidden })
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODE.VALIDATION_ERROR);
    }

    const after = await harness.patients.findByCode('P0002');
    expect(after!.riskScore).toBeNull();
    expect(after!.version).toBe(1);
  });

  it('enforces clinical bounds server-side, at both ends', async () => {
    for (const value of [CLINICAL_BOUNDS.glucose.min - 1, CLINICAL_BOUNDS.glucose.max + 1]) {
      await request(harness.app)
        .post('/api/online-update')
        .send({ patientCode: 'P0003', actorType: ACTOR_TYPE.LAB, changes: { glucose: value } })
        .expect(400);
    }

    // Accepts the boundary itself, so the bound is inclusive rather than accidentally off by one.
    await request(harness.app)
      .post('/api/online-update')
      .send({
        patientCode: 'P0003',
        actorType: ACTOR_TYPE.LAB,
        changes: { glucose: CLINICAL_BOUNDS.glucose.max },
      })
      .expect(200);
  });

  it('rejects a non-integer clinical value and an unknown diagnosis', async () => {
    await request(harness.app)
      .post('/api/online-update')
      .send({ patientCode: 'P0004', actorType: ACTOR_TYPE.LAB, changes: { glucose: 120.5 } })
      .expect(400);

    await request(harness.app)
      .post('/api/online-update')
      .send({ patientCode: 'P0004', actorType: ACTOR_TYPE.DOCTOR, changes: { diagnosis: 'MADE_UP' } })
      .expect(400);
  });

  it('accepts every recognised diagnosis', async () => {
    // Guards against the enum and the schema drifting apart, which would silently disable a demo control.
    for (const diagnosis of Object.values(DIAGNOSIS)) {
      const response = await request(harness.app)
        .post('/api/online-update')
        .send({ patientCode: 'P0005', actorType: ACTOR_TYPE.DOCTOR, changes: { diagnosis } });

      expect(response.status).toBe(200);
    }
  });

  it('rejects an unknown actor and an unknown top-level field', async () => {
    await request(harness.app)
      .post('/api/online-update')
      .send({ patientCode: 'P0006', actorType: 'JANITOR', changes: { glucose: 150 } })
      .expect(400);

    await request(harness.app)
      .post('/api/online-update')
      .send({ patientCode: 'P0006', actorType: ACTOR_TYPE.LAB, changes: { glucose: 150 }, force: true })
      .expect(400);
  });

  it('rejects an empty change set instead of burning a version', async () => {
    const response = await request(harness.app)
      .post('/api/online-update')
      .send({ patientCode: 'P0006', actorType: ACTOR_TYPE.LAB, changes: {} })
      .expect(400);

    expect(response.body.error.code).toBe(ERROR_CODE.VALIDATION_ERROR);
  });

  it('generates a realistic escalation when no changes are supplied', async () => {
    const response = await request(harness.app)
      .post('/api/online-update')
      .send({ actorType: ACTOR_TYPE.NURSE })
      .expect(200);

    expect(response.body.applied).toBe(true);
    expect(response.body.changedFields.length).toBeGreaterThan(0);
  });

  it('reports a missing patient as 404 with its code', async () => {
    const response = await request(harness.app)
      .post('/api/online-update')
      .send({ patientCode: 'P0999', actorType: ACTOR_TYPE.LAB, changes: { glucose: 150 } })
      .expect(404);

    expect(response.body.error.code).toBe(ERROR_CODE.PATIENT_NOT_FOUND);
  });
});

describe('API: backfill lifecycle', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('starts a run and reports state', async () => {
    const response = await request(harness.app)
      .post('/api/backfill/start')
      .send({ backfillSpeed: 500 })
      .expect(200);

    expect(response.body.status).toBe(JOB_STATUS.RUNNING);
    expect(response.body.metrics.eligibleRecords).toBe(TOTAL);
    // Nothing has been decided yet, so coverage must read zero rather than inheriting a previous run.
    expect(response.body.metrics.processed).toBe(0);

    // Stop the paced loop through the API, so nothing is left advancing after the case ends.
    await request(harness.app).post('/api/reset').expect(200);
  });

  it('rejects a setting outside its bound, and an unknown setting', async () => {
    await request(harness.app)
      .post('/api/backfill/start')
      .send({ batchSize: SIMULATION_BOUNDS.batchSize.max + 1 })
      .expect(400);

    await request(harness.app).post('/api/backfill/start').send({ turboMode: true }).expect(400);
  });

  it('refuses a setting that describes the dataset rather than the run', async () => {
    // Accepting these would let a run be configured for a shape the data does not have.
    await request(harness.app).post('/api/backfill/start').send({ totalRecords: 500 }).expect(400);
    await request(harness.app).post('/api/backfill/start').send({ partitionCount: 3 }).expect(400);
  });

  it('returns 409 naming the current state and the allowed states', async () => {
    /**
     * This is what lets the UI disable a control with a real explanation instead of failing on click (R8.7).
     */
    const response = await request(harness.app).post('/api/backfill/pause').expect(409);

    expect(response.body.error.code).toBe(ERROR_CODE.INVALID_JOB_STATE);
    expect(response.body.error.message).toContain('while the job is IDLE');
    expect(response.body.error.details).toMatchObject({
      currentStatus: JOB_STATUS.IDLE,
      allowedFrom: [JOB_STATUS.RUNNING, JOB_STATUS.RECOVERING],
    });
  });

  it('refuses verification of a job that has not settled', async () => {
    const response = await request(harness.app).post('/api/verify').expect(409);
    expect(response.body.error.code).toBe(ERROR_CODE.INVALID_JOB_STATE);
  });

  it('reports no verification report until one has been produced', async () => {
    // A 404 rather than an empty shell, so the report page can offer to run the audit instead of
    // rendering zeros that look like measurements (R20.7).
    const response = await request(harness.app).get('/api/verify/latest').expect(404);
    expect(response.body.error.code).toBe(ERROR_CODE.NOT_FOUND);
  });

  it('runs a full lifecycle through the API and exports the audit', async () => {
    /**
     * Started directly with `autoAdvance: false` rather than through the API.
     *
     * The endpoint starts the paced background loop, and driving `runToCompletion` alongside it would put two
     * drivers on one engine — double-stepping records and making ordering unpredictable. The endpoint's own
     * behaviour is covered above; what this case is about is the state, verify and export endpoints reading a
     * finished run.
     */
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const state = await request(harness.app).get('/api/backfill/state').expect(200);
    expect(state.body.status).toBe(JOB_STATUS.COMPLETED);
    expect(state.body.metrics.processed).toBe(TOTAL);

    const verify = await request(harness.app).post('/api/verify').expect(200);
    expect(verify.body.verdict).toBe('VERIFIED_SAFE');
    expect(verify.body.metrics.coveragePercent).toBe(100);
    expect(verify.body.metrics.staleOverwrites).toBe(0);

    const exported = await request(harness.app)
      .get('/api/verify/latest/export.json')
      .expect(200);

    expect(exported.headers['content-disposition']).toContain('attachment');
    expect(exported.headers['content-disposition']).toContain('VERIFIED_SAFE');
    expect(exported.body.disclaimer).toMatch(/no clinical meaning/);
  });

  it('refuses to destroy a checkpoint when there is none', async () => {
    // A destructive action must not report success having done nothing (R7.6).
    const response = await request(harness.app).post('/api/checkpoint/lose').expect(409);
    expect(response.body.error.code).toBe(ERROR_CODE.CHECKPOINT_MISSING);
  });

  it('serves conflicts from stored rows', async () => {
    const response = await request(harness.app).get('/api/backfill/conflicts').expect(200);
    expect(response.body).toMatchObject({ total: 0, open: 0, conflicts: [] });
  });
});

describe('API: dataset lifecycle', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('reseeds within bounds and rejects anything outside them', async () => {
    const response = await request(harness.app)
      .post('/api/seed')
      .send({ totalRecords: 120, partitionCount: 3 })
      .expect(200);

    expect(response.body.totalRecords).toBe(120);
    expect(response.body.partitionSizes).toEqual([40, 40, 40]);

    await request(harness.app).post('/api/seed').send({ totalRecords: 10 }).expect(400);
    await request(harness.app).post('/api/seed').send({ partitionCount: 99 }).expect(400);
    await request(harness.app).post('/api/seed').send({ nope: 1 }).expect(400);
  });

  it('refuses to reseed while a run owns the data', async () => {
    await request(harness.app).post('/api/backfill/start').expect(200);

    const response = await request(harness.app).post('/api/seed').send({ totalRecords: 200 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ERROR_CODE.INVALID_JOB_STATE);

    await request(harness.app).post('/api/reset').expect(200);
  });

  it('allows reset even from a running job, and keeps the patients', async () => {
    // Reset is the escape hatch and must work from a job wedged mid-demo.
    await request(harness.app).post('/api/backfill/start').expect(200);

    const response = await request(harness.app).post('/api/reset').expect(200);
    expect(response.body).toEqual({ reset: true, patientCount: TOTAL });

    const state = await request(harness.app).get('/api/backfill/state').expect(200);
    expect(state.body.status).toBe(JOB_STATUS.IDLE);
    // No run means nothing measured, which is reported as null rather than as zeros.
    expect(state.body.metrics).toBeNull();
  });

  it('refuses to start a backfill with no data, naming the fix', async () => {
    const empty = await makeHarness({ seedData: false });

    const response = await request(empty.app).post('/api/backfill/start');
    expect(response.status).toBe(500);
    expect(response.body.error.message).toContain('Seed the dataset first');
  });
});

describe('API: comparison, events and scenario', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('runs the comparison in isolation from the live dataset', async () => {
    const response = await request(harness.app)
      .post('/api/compare/run')
      .send({ scenario: 'contended' })
      .expect(200);

    expect(response.body.naive.metrics.staleOverwrites).toBeGreaterThan(0);
    expect(response.body.guarded.metrics.staleOverwrites).toBe(0);
    expect(response.body.headline.guarded).toBe('STALE OVERWRITE PREVENTED');

    // The unsafe engine must have had no path to the demo data.
    expect(await harness.patients.countAll()).toBe(TOTAL);
    const untouched = await harness.patients.findByCode('P0001');
    expect(untouched!.riskScore).toBeNull();
  });

  it('rejects an unknown comparison scenario', async () => {
    await request(harness.app).post('/api/compare/run').send({ scenario: 'rigged' }).expect(400);
  });

  it('reports no comparison until one has been run', async () => {
    await request(harness.app).get('/api/compare/latest').expect(404);
  });

  it('serves the event log with a gap-fill cursor', async () => {
    await request(harness.app).post('/api/backfill/start').expect(200);
    await harness.orchestrator.runToCompletion();

    const all = await request(harness.app).get('/api/events?limit=5').expect(200);
    expect(all.body.events).toHaveLength(5);
    expect(all.body.latestSequence).toBeGreaterThan(5);
    // Non-zero would mean the durable log is incomplete, so it is reported rather than hidden.
    expect(all.body.droppedCount).toBe(0);

    const since = await request(harness.app).get('/api/events?sinceSequence=3&limit=2').expect(200);
    expect(since.body.events.map((event: { sequence: number }) => event.sequence)).toEqual([4, 5]);
  });

  it('rejects an out-of-range event limit', async () => {
    await request(harness.app).get('/api/events?limit=99999').expect(400);
  });

  it('accepts the scripted demo and reports its steps immediately', async () => {
    /**
     * 202, not 200: the run takes tens of seconds by design, so holding the request open would let a proxy
     * timeout kill the demo halfway through. Progress arrives on the event stream instead.
     */
    const paced = await makeHarness({ tickDelayMs: 20 });
    const response = await request(paced.app).post('/api/scenario/demo').expect(202);

    expect(response.body.accepted).toBe(true);
    expect(response.body.scenario.steps).toHaveLength(8);
    expect(response.body.scenario.running).toBe(true);

    await request(paced.app).post('/api/scenario/abort').expect(200);
    await request(paced.app).post('/api/reset').expect(200);
  });

  it('refuses a second demo while one is running', async () => {
    // Paced so the first run is unambiguously still in progress when the second request arrives; at zero
    // delay a 40-record demo can finish inside one request and the guard would never be exercised.
    const paced = await makeHarness({ tickDelayMs: 20 });

    await request(paced.app).post('/api/scenario/demo').expect(202);

    const response = await request(paced.app).post('/api/scenario/demo').expect(422);
    expect(response.body.error.code).toBe(ERROR_CODE.SCENARIO_FAILED);
    expect(response.body.error.message).toMatch(/already in progress/);

    await request(paced.app).post('/api/scenario/abort').expect(200);
    await request(paced.app).post('/api/reset').expect(200);
  });
});

/**
 * The notification HTTP surface.
 *
 * The claim these tests protect is narrow and important: **nothing a client can send causes a risk alert to be
 * fabricated.** The only route that transmits anything is the explicitly-labelled test send, and it reports the
 * patient's real recomputed risk rather than a chosen one. Status, provider id and dedup key are all rejected as
 * input, so a caller cannot assert that an alert was delivered when it was not.
 */
describe('API: notifications', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('lists nothing before a run, and says the provider is simulated', async () => {
    const response = await request(harness.app).get('/api/notifications').expect(200);

    expect(response.body.notifications).toEqual([]);
    expect(response.body.provider).toEqual({ name: 'demo', simulated: true });
    expect(response.body.disclaimer).toBeTruthy();
  });

  it('reports empty stats with a null success rate rather than a flattering 100%', async () => {
    const response = await request(harness.app).get('/api/notifications/stats').expect(200);

    expect(response.body.total).toBe(0);
    expect(response.body.sent).toBe(0);
    // Null is the honest answer when nothing was attempted; 100% would be a measurement of nothing.
    expect(response.body.successRate).toBeNull();
  });

  it('produces sent alerts for the HIGH patients a completed run committed', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const list = await request(harness.app).get('/api/notifications').expect(200);
    const records = list.body.notifications as { status: string; riskLevel: string }[];

    expect(records.length).toBeGreaterThan(0);

    // Every alert from a clean run describes a HIGH result that was committed under its version guard.
    expect(records.every((record) => record.riskLevel === RISK_LEVEL.HIGH)).toBe(true);
    expect(records.every((record) => record.status === 'SENT')).toBe(true);

    const stats = await request(harness.app).get('/api/notifications/stats').expect(200);
    expect(stats.body.sent).toBe(records.length);
    expect(stats.body.failed).toBe(0);
    expect(stats.body.successRate).toBe(100);
    expect(stats.body.highRiskPatients).toBeGreaterThan(0);
  });

  it('never sends an alert for a patient below the HIGH band', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const low = await request(harness.app)
      .get(`/api/notifications?riskLevel=${RISK_LEVEL.LOW}`)
      .expect(200);
    const medium = await request(harness.app)
      .get(`/api/notifications?riskLevel=${RISK_LEVEL.MEDIUM}`)
      .expect(200);

    expect(low.body.notifications).toEqual([]);
    expect(medium.body.notifications).toEqual([]);
  });

  it('filters by status and by patient code', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const sent = await request(harness.app).get('/api/notifications?status=SENT').expect(200);
    expect(sent.body.notifications.length).toBeGreaterThan(0);

    const code = sent.body.notifications[0].patientCode as string;
    const byCode = await request(harness.app)
      .get(`/api/notifications?patientCode=${code}`)
      .expect(200);

    expect(byCode.body.notifications.length).toBeGreaterThan(0);
    expect(
      (byCode.body.notifications as { patientCode: string }[]).every(
        (record) => record.patientCode === code,
      ),
    ).toBe(true);
  });

  it('serves one notification by id, including its full message body', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const list = await request(harness.app).get('/api/notifications?limit=1').expect(200);
    const id = list.body.notifications[0].id as number;

    const response = await request(harness.app).get(`/api/notifications/${id}`).expect(200);

    expect(response.body.notification.id).toBe(id);
    expect(response.body.notification.message).toBeTruthy();
    // The disclaimer travels in the message body itself, not only alongside it.
    expect(response.body.notification.message.toLowerCase()).toContain('synthetic');
    expect(response.body.notification.recipient).toMatch(/^\+91 90000\d{5}$/);
  });

  it('returns a structured 404 for an unknown notification id', async () => {
    const response = await request(harness.app).get('/api/notifications/999999').expect(404);

    expect(response.body.error.code).toBe(ERROR_CODE.NOT_FOUND);
  });

  it('rejects a malformed id and an unknown filter', async () => {
    await request(harness.app).get('/api/notifications/not-a-number').expect(400);
    await request(harness.app).get('/api/notifications?status=DELIVERED').expect(400);
    await request(harness.app).get('/api/notifications?somethingElse=1').expect(400);
    await request(harness.app).get('/api/notifications?limit=99999').expect(400);
  });

  // ---------------------------------------------------------------- the manual test send

  it('sends a test alert reporting the patient\u2019s real current risk', async () => {
    const response = await request(harness.app)
      .post('/api/notifications/test')
      .send({})
      .expect(201);

    const record = response.body.notification;

    expect(record.status).toBe('SENT');
    expect(record.reason).toBe('MANUAL_TEST');
    expect(record.providerMessageId).toMatch(/^DEMO-WA-\d{6}$/);
    expect(response.body.provider).toEqual({ name: 'demo', simulated: true });

    // The figures are recomputed from the record, not chosen by the caller.
    const patient = await harness.patients.findById(record.patientId);
    expect(record.patientVersion).toBe(patient!.version);
  });

  it('files manual tests under their own job so they cannot inflate a run\u2019s figures', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const jobId = (await request(harness.app).get('/api/backfill/state').expect(200)).body.jobId;
    const before = await request(harness.app)
      .get(`/api/notifications/stats?jobId=${jobId}`)
      .expect(200);

    await request(harness.app).post('/api/notifications/test').send({}).expect(201);

    const after = await request(harness.app)
      .get(`/api/notifications/stats?jobId=${jobId}`)
      .expect(200);

    // The run's own statistics are unchanged: they are evidence about the backfill, not about button presses.
    expect(after.body.sent).toBe(before.body.sent);
    expect(after.body.total).toBe(before.body.total);
  });

  it('accepts a specific patient and 404s an unknown one', async () => {
    const first = await request(harness.app).get('/api/patients?pageSize=1').expect(200);
    const code = first.body.items[0].patientCode as string;

    const response = await request(harness.app)
      .post('/api/notifications/test')
      .send({ patientCode: code })
      .expect(201);

    expect(response.body.notification.patientCode).toBe(code);

    await request(harness.app)
      .post('/api/notifications/test')
      .send({ patientCode: 'P999999' })
      .expect(404);
  });

  it('refuses a test send that tries to dictate the outcome', async () => {
    // The whole point of the feature is that status is a consequence of a guarded write, never an input.
    await request(harness.app)
      .post('/api/notifications/test')
      .send({ status: 'SENT' })
      .expect(400);

    await request(harness.app)
      .post('/api/notifications/test')
      .send({ riskLevel: RISK_LEVEL.HIGH, riskScore: 99 })
      .expect(400);

    await request(harness.app)
      .post('/api/notifications/test')
      .send({ providerMessageId: 'DEMO-WA-000001' })
      .expect(400);

    await request(harness.app)
      .post('/api/notifications/test')
      .send({ idempotencyKey: 'forged' })
      .expect(400);
  });

  it('repeated test sends each produce their own record', async () => {
    const first = await request(harness.app).post('/api/notifications/test').send({}).expect(201);
    const second = await request(harness.app).post('/api/notifications/test').send({}).expect(201);

    // Salted keys, so a manual press can neither collide with nor suppress a genuine alert.
    expect(second.body.notification.id).not.toBe(first.body.notification.id);
    expect(second.body.notification.idempotencyKey).not.toBe(
      first.body.notification.idempotencyKey,
    );
  });

  it('clears notifications on reset', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    expect(
      (await request(harness.app).get('/api/notifications').expect(200)).body.notifications.length,
    ).toBeGreaterThan(0);

    await request(harness.app).post('/api/reset').expect(200);

    const after = await request(harness.app).get('/api/notifications').expect(200);
    expect(after.body.notifications).toEqual([]);
  });
});
