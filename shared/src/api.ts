import type { ErrorCode } from './enums';

/** Structured error envelope returned by every failing endpoint (R1.6, R23.2). */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Actionable, human-readable. Safe to render directly in the UI (R23.5). */
    message: string;
    /** Relevant identifiers, e.g. { patientCode, expectedVersion, currentVersion }. */
    details?: Record<string, unknown>;
    /** Present only outside production (R23.7). */
    stack?: string;
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  database: {
    connected: boolean;
    /** Null when the dataset has not been seeded yet. */
    patientCount: number | null;
  };
  uptimeSeconds: number;
  timestamp: string;
}

/** Named step in the scripted demo, used for the step tracker in the UI (R18.7). */
export interface ScenarioStepState {
  index: number;
  name: string;
  description: string;
  status: 'PENDING' | 'ACTIVE' | 'DONE' | 'SKIPPED';
  /** Processed-record count that triggers this step — the basis of determinism (R18.3). */
  atProcessed: number | null;
}

export interface ScenarioState {
  running: boolean;
  name: string | null;
  currentStepIndex: number | null;
  steps: ScenarioStepState[];
  startedAt: string | null;
  completedAt: string | null;
  abortedAt: string | null;
}
