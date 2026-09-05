/**
 * @bg/shared — the single source of truth for types, enums and bounds shared by the BackfillGuard
 * backend and frontend (R1.5).
 *
 * Consumed directly from source: the backend resolves it via tsconfig `paths` (tsx loads TS
 * natively) and the frontend via a Vite alias. There is deliberately no build step and no
 * dist-versus-src ambiguity to get out of sync.
 */

export * from './enums';
export * from './config';
export * from './patient';
export * from './job';
export * from './events';
export * from './verification';
export * from './api';
export * from './jobActions';
