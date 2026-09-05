import type { ApiErrorBody, ErrorCode } from '@bg/shared';

/**
 * Typed API client.
 *
 * Server errors arrive as a structured envelope, so they are rethrown as `ApiError` carrying the
 * machine-readable code and the actionable message. The UI renders `message` directly — that is the
 * whole reason the backend takes care to write useful ones (R23.5).
 */

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Requests go to a relative path; the Vite dev server proxies /api to the backend. */
const BASE_URL = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (cause) {
    // Distinguish "backend unreachable" from "backend said no" so the UI can offer a retry (R23.6).
    throw new ApiError(
      'NETWORK_ERROR',
      'Cannot reach the BackfillGuard backend. Is it running on port 4000?',
      0,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }

  if (!response.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error response; fall through to a generic message below.
    }

    throw new ApiError(
      body?.error.code ?? 'INTERNAL_ERROR',
      body?.error.message ?? `Request failed with status ${response.status}.`,
      response.status,
      body?.error.details,
    );
  }

  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
};
