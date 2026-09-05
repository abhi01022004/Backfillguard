import {
  ACTOR_TYPE,
  CLINICAL_BOUNDS,
  CLINICAL_FIELDS,
  DIAGNOSIS,
  EVENT_SEVERITY,
  EVENT_TYPE,
  UPDATE_SOURCE,
  type ActorType,
  type ClinicalField,
  type Diagnosis,
  type FieldChange,
  type Patient,
  type UpdateSource,
} from '@bg/shared';
import type { Rng } from '../../lib/rng';
import type { EventSink } from '../ports/EventSink';
import type { PatientRepository } from '../ports/PatientRepository';
import type { TickContext, TickParticipant } from '../orchestrator/SimulationOrchestrator';
import { ConcurrentUpdateError, PatientNotFoundError, ValidationError } from '../../lib/errors';
import {
  actorLabel,
  buildEscalatingChanges,
  type ClinicalChanges,
} from './clinicalMutations';

/**
 * Simulates doctors, nurses and laboratories editing records while the backfill runs (R6).
 *
 * This is the source of contention. The backfill is only interesting because these updates exist, and
 * the safety guarantee is only meaningful because they can land at the worst possible moment.
 *
 * Three modes:
 *
 *  - `MANUAL`   — a judge presses a button. Field values may be supplied explicitly or generated.
 *  - `AUTO`     — a bounded background stream, driven by processed-record counts rather than a timer.
 *  - `SCRIPTED` — fixed patients and fixed values, for the reproducible demo.
 *
 * Note what this class does *not* do: it never recomputes the risk score. An online update changes
 * clinical data and bumps the version, leaving the stored score derived from older data. That gap is
 * the phenomenon being demonstrated, so closing it here would defeat the entire point.
 */

export interface OnlineUpdateSimulatorDeps {
  repository: PatientRepository;
  events: EventSink;
  rng: Rng;
}

export interface OnlineUpdateResult {
  patient: Patient;
  actorType: ActorType;
  changedFields: FieldChange[];
  previousVersion: number;
  newVersion: number;
  source: UpdateSource;
}

/** How AUTO mode chooses which record to touch. */
export const TARGET_STRATEGY = {
  /**
   * Prefer records the engine has read but not yet written.
   *
   * Chosen as the default because it is the only window in which an update can create staleness. With
   * uniform random targeting most updates would land on records already written (producing
   * post-consideration drift) or not yet read (producing nothing at all), so a demo would show very few
   * conflicts and the safety mechanism would rarely be exercised.
   *
   * This is a simulation biased toward the interesting case, not a claim about how real hospital traffic
   * is distributed — and it is honest to say so, because the *mechanism* under test is identical either
   * way; only the frequency differs.
   */
  IN_FLIGHT: 'IN_FLIGHT',
  /** Uniform across the dataset. Produces mostly drift rather than conflicts. */
  RANDOM: 'RANDOM',
} as const;
export type TargetStrategy = (typeof TARGET_STRATEGY)[keyof typeof TARGET_STRATEGY];

const ACTOR_ROTATION: readonly ActorType[] = [
  ACTOR_TYPE.LAB,
  ACTOR_TYPE.DOCTOR,
  ACTOR_TYPE.NURSE,
];

export class OnlineUpdateSimulator {
  /** Rotates actors so the activity feed shows a realistic mix rather than one repeated role. */
  private actorCursor = 0;

  /** Records read at the last AUTO emission, used to space updates by progress not time. */
  private lastEmissionAtRead = 0;

  private autoEnabled = false;
  private updatesPerHundred = 0;
  private strategy: TargetStrategy = TARGET_STRATEGY.IN_FLIGHT;

  private appliedCount = 0;

  constructor(private readonly deps: OnlineUpdateSimulatorDeps) {}

  // ------------------------------------------------------------------ core apply

  /**
   * Applies a clinical update under the repository's version guard.
   *
   * Validation happens here rather than only at the API boundary, so the scripted and automatic paths
   * are held to the same rules as a client request (R22.7).
   */
  async apply(params: {
    patientCode: string;
    actorType: ActorType;
    changes: ClinicalChanges;
    source: UpdateSource;
  }): Promise<OnlineUpdateResult> {
    const { patientCode, actorType, changes, source } = params;

    const patient = await this.deps.repository.findByCode(patientCode);
    if (!patient) throw new PatientNotFoundError(patientCode);

    assertChangesAreValid(changes);

    const previousVersion = patient.version;

    const result = await this.deps.repository.applyOnlineUpdate(
      patient.id,
      previousVersion,
      changes,
      actorType,
      source,
    );

    // Null means the row's version moved between our read and the guarded write: another update won.
    if (!result) throw new ConcurrentUpdateError(patientCode);

    // A change set that matched the existing values is a no-op; the version was deliberately not
    // consumed, and emitting an event would imply something happened.
    if (result.changedFields.length === 0) {
      return {
        patient: result.patient,
        actorType,
        changedFields: [],
        previousVersion,
        newVersion: result.patient.version,
        source,
      };
    }

    this.appliedCount += 1;

    this.deps.events.emit({
      type: EVENT_TYPE.ONLINE_UPDATE,
      severity: EVENT_SEVERITY.WARNING,
      patientCode,
      partitionIndex: result.patient.partitionIndex,
      message:
        `${actorLabel(actorType)} updated ${patientCode}: ` +
        `${result.changedFields.map((c) => `${c.field} ${c.from} → ${c.to}`).join(', ')} ` +
        `(v${previousVersion} → v${result.patient.version}).`,
      payload: {
        patientId: result.patient.id,
        actorType,
        changedFields: result.changedFields,
        previousVersion,
        newVersion: result.patient.version,
        source,
      },
    });

    return {
      patient: result.patient,
      actorType,
      changedFields: result.changedFields,
      previousVersion,
      newVersion: result.patient.version,
      source,
    };
  }

  /**
   * Applies a generated escalating update to a chosen patient.
   *
   * Returns null when the patient is already at the ceiling on every field the actor controls, rather
   * than forcing a no-op update through.
   */
  async applyGenerated(params: {
    patientCode: string;
    actorType: ActorType;
    source: UpdateSource;
  }): Promise<OnlineUpdateResult | null> {
    const patient = await this.deps.repository.findByCode(params.patientCode);
    if (!patient) throw new PatientNotFoundError(params.patientCode);

    const changes = buildEscalatingChanges(params.actorType, patient, this.deps.rng);
    if (!changes) return null;

    return this.apply({ ...params, changes });
  }

  // ------------------------------------------------------------------ manual mode

  /**
   * Triggers one update for the UI buttons (R6.5).
   *
   * With no patient code, picks a target itself so the control works with a single click.
   */
  async triggerManual(params: {
    actorType: ActorType;
    patientCode?: string;
    changes?: ClinicalChanges;
    inFlightCodes?: string[];
  }): Promise<OnlineUpdateResult | null> {
    const code = params.patientCode ?? (await this.chooseTarget(params.inFlightCodes ?? []));

    if (!code) {
      throw new ValidationError(
        'No patient available to update. Seed the dataset first.',
      );
    }

    if (params.changes && Object.keys(params.changes).length > 0) {
      return this.apply({
        patientCode: code,
        actorType: params.actorType,
        changes: params.changes,
        source: UPDATE_SOURCE.MANUAL,
      });
    }

    return this.applyGenerated({
      patientCode: code,
      actorType: params.actorType,
      source: UPDATE_SOURCE.MANUAL,
    });
  }

  // ------------------------------------------------------------------ auto mode

  configureAuto(updatesPerHundred: number, strategy: TargetStrategy = TARGET_STRATEGY.IN_FLIGHT): void {
    this.updatesPerHundred = updatesPerHundred;
    this.strategy = strategy;
    this.autoEnabled = updatesPerHundred > 0;
    this.lastEmissionAtRead = 0;
  }

  stopAuto(): void {
    this.autoEnabled = false;
  }

  /**
   * Tick participant for the automatic stream (R6.6).
   *
   * Spacing is derived from records read, not elapsed time. Two consequences, both intended: the update
   * rate is proportional to backfill progress regardless of machine speed, and the resulting conflict
   * set is reproducible from the seed.
   */
  asTickParticipant(): TickParticipant {
    return {
      beforeStep: async (context: TickContext) => {
        if (!this.autoEnabled || this.updatesPerHundred <= 0) return;

        const interval = Math.max(1, Math.floor(100 / this.updatesPerHundred));
        if (context.recordsRead - this.lastEmissionAtRead < interval) return;
        this.lastEmissionAtRead = context.recordsRead;

        const code = await this.chooseTarget(context.inFlightCodes);
        if (!code) return;

        const actorType = this.nextActor();

        try {
          await this.applyGenerated({ patientCode: code, actorType, source: UPDATE_SOURCE.AUTO });
        } catch (error) {
          // A losing race is an expected outcome for a background writer, not a failure of the run.
          // Swallowing anything else would hide a real bug, so only that case is tolerated.
          if (!(error instanceof ConcurrentUpdateError)) throw error;
        }
      },
    };
  }

  // ------------------------------------------------------------------ scripted mode

  /**
   * Applies a fixed set of updates with fixed values (R6.7).
   *
   * The demo depends on this rather than on generated values: explicit numbers make the scenario
   * auditable, and mean a change to the mutation heuristics cannot silently alter the headline demo.
   */
  async applyScripted(
    updates: readonly { patientCode: string; actorType: ActorType; changes: ClinicalChanges }[],
  ): Promise<OnlineUpdateResult[]> {
    const results: OnlineUpdateResult[] = [];

    for (const update of updates) {
      results.push(
        await this.apply({
          patientCode: update.patientCode,
          actorType: update.actorType,
          changes: update.changes,
          source: UPDATE_SOURCE.SCRIPTED,
        }),
      );
    }

    return results;
  }

  // ------------------------------------------------------------------ helpers

  private nextActor(): ActorType {
    const actor = ACTOR_ROTATION[this.actorCursor % ACTOR_ROTATION.length]!;
    this.actorCursor += 1;
    return actor;
  }

  /** Prefers an in-flight record when the strategy asks for it, else falls back to a random one. */
  private async chooseTarget(inFlightCodes: string[]): Promise<string | null> {
    if (this.strategy === TARGET_STRATEGY.IN_FLIGHT && inFlightCodes.length > 0) {
      return this.deps.rng.pick(inFlightCodes);
    }

    const ids = await this.deps.repository.allIds();
    if (ids.length === 0) return null;

    const id = this.deps.rng.pick(ids);
    const patient = await this.deps.repository.findById(id);
    return patient?.patientCode ?? null;
  }

  get totalApplied(): number {
    return this.appliedCount;
  }

  resetCounters(): void {
    this.appliedCount = 0;
    this.actorCursor = 0;
    this.lastEmissionAtRead = 0;
  }
}

/**
 * Server-side validation of a change set (R6.2, R6.8, R22.5, R22.7).
 *
 * Enforced in the domain, not only at the HTTP boundary, so every path — manual, automatic, scripted —
 * is held to the same rules. In particular this is what makes it impossible to reach `riskScore`,
 * `riskLevel`, `version` or `lastBackfillVersion` through an update, regardless of how it was triggered.
 */
export function assertChangesAreValid(changes: ClinicalChanges): void {
  const entries = Object.entries(changes).filter(([, value]) => value !== undefined);

  if (entries.length === 0) {
    throw new ValidationError('An online update must change at least one clinical field.', {
      allowedFields: CLINICAL_FIELDS,
    });
  }

  for (const [field, value] of entries) {
    if (!(CLINICAL_FIELDS as readonly string[]).includes(field)) {
      throw new ValidationError(
        `"${field}" is not a clinical field that may be updated online.`,
        { field, allowedFields: CLINICAL_FIELDS },
      );
    }

    if (field === 'diagnosis') {
      if (!(Object.values(DIAGNOSIS) as string[]).includes(String(value))) {
        throw new ValidationError(`"${String(value)}" is not a recognised diagnosis.`, {
          field,
          allowed: Object.values(DIAGNOSIS),
        });
      }
      continue;
    }

    const bound = CLINICAL_BOUNDS[field as keyof typeof CLINICAL_BOUNDS];
    if (!bound) {
      throw new ValidationError(`"${field}" has no configured bounds and cannot be updated.`, {
        field,
      });
    }

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ValidationError(`${field} must be an integer, received "${String(value)}".`, {
        field,
        value,
      });
    }

    if (value < bound.min || value > bound.max) {
      throw new ValidationError(
        `${field} must be between ${bound.min} and ${bound.max}, received ${value}.`,
        { field, value, min: bound.min, max: bound.max },
      );
    }
  }
}

export type { ClinicalChanges, ClinicalField, Diagnosis };
