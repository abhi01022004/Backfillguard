import type {
  BackfillStatus,
  ClinicalField,
  Diagnosis,
  RiskLevel,
  ActorType,
  UpdateSource,
} from './enums';

/**
 * A synthetic patient record (R2.3).
 *
 * The version model is the crux of the whole design: `version` tracks *source data* only. It is
 * incremented exclusively by online updates. Backfill engines write the derived block
 * (`riskScore`, `riskLevel`, `backfillStatus`, `lastBackfillVersion`) and never touch `version`
 * or any clinical field. That is what makes `lastBackfillVersion === version` a meaningful,
 * independently checkable statement about correctness.
 */
export interface Patient {
  id: number;
  patientCode: string;

  // --- demographics (synthetic) ---
  name: string;
  age: number;

  // --- clinical source fields: only online updates may change these ---
  bloodPressureSystolic: number;
  bloodPressureDiastolic: number;
  heartRate: number;
  glucose: number;
  diagnosis: Diagnosis;

  partitionIndex: number;

  /** Source-data version. Incremented only by online updates. */
  version: number;

  // --- derived block: only backfill engines write these ---
  /** Null until the record has been scored. */
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  backfillStatus: BackfillStatus;
  /** The source version `riskScore` was computed from. Null until first scored. */
  lastBackfillVersion: number | null;

  createdAt: string;
  updatedAt: string;
}

/** The subset of a patient the risk calculator reads. Pure input, no identity. */
export interface RiskInput {
  age: number;
  bloodPressureSystolic: number;
  bloodPressureDiastolic: number;
  heartRate: number;
  glucose: number;
  diagnosis: Diagnosis;
}

/** One factor's contribution, for the explainable breakdown (R3.6). */
export interface RiskFactorContribution {
  factor: 'age' | 'bloodPressure' | 'glucose' | 'heartRate' | 'diagnosis';
  /** Which band matched, e.g. 'veryHigh'. */
  band: string;
  points: number;
  /** Human-readable input summary, e.g. '168/104 mmHg'. */
  inputSummary: string;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  breakdown: RiskFactorContribution[];
  /** Bumped when RISK_CONFIG changes, so stored scores can be traced to a formula version. */
  configVersion: string;
}

/** A single field change, used by online updates, conflicts and history (R6.4). */
export interface FieldChange {
  field: ClinicalField;
  from: string | number;
  to: string | number;
}

export interface OnlineUpdateRecord {
  id: number;
  patientId: number;
  patientCode: string;
  actorType: ActorType;
  changedFields: FieldChange[];
  previousVersion: number;
  newVersion: number;
  source: UpdateSource;
  createdAt: string;
}

/** Request body for a manual online update. `changes` is optional: omit for a scripted mutation. */
export interface OnlineUpdateRequest {
  patientCode?: string;
  actorType: ActorType;
  changes?: Partial<Record<ClinicalField, string | number>>;
}

export interface PatientListQuery {
  page?: number;
  pageSize?: number;
  status?: BackfillStatus;
  riskLevel?: RiskLevel;
  partitionIndex?: number;
  /** Free-text match on patient code or name. */
  q?: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PatientDetail {
  patient: Patient;
  /** Recomputed live from current values, so the UI can show why the score is what it is. */
  risk: RiskResult | null;
  history: PatientHistoryEntry[];
}

/**
 * One entry in the merged per-patient timeline (R16.4): online updates, backfill reads, write
 * outcomes, conflicts and re-evaluations interleaved in chronological order.
 */
export interface PatientHistoryEntry {
  kind:
    | 'ONLINE_UPDATE'
    | 'BACKFILL_READ'
    | 'WRITE_APPLIED'
    | 'WRITE_REJECTED'
    | 'CONFLICT'
    | 'REEVALUATION'
    | 'NO_ACTION';
  /** The source version this entry relates to. */
  version: number;
  at: string;
  /** Short human-readable summary, e.g. 'Doctor updated glucose 165 → 190'. */
  summary: string;
  actorType?: ActorType;
  changedFields?: FieldChange[];
  scoreBefore?: number | null;
  scoreAfter?: number | null;
  /** Set on conflict entries: the score that was computed but never allowed to land. */
  rejectedScore?: number;
}
