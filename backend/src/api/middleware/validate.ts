import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType, type z } from 'zod';
import { ValidationError } from '../../lib/errors';

/**
 * Schema validation for request body, params and query (R22.4).
 *
 * Schemas should be `z.strictObject(...)` so unknown keys are rejected rather than silently stripped
 * — an unrecognised field in a version-sensitive request is a bug worth surfacing, not something to
 * drop quietly.
 *
 * Validated output is attached to `req.validated` rather than written back over `req.query` /
 * `req.params`. Express 5 exposes those as getters without setters, so assigning to them throws; and
 * a separate namespace is clearer anyway, because a handler reading `req.validated.body` is provably
 * reading parsed, coerced input rather than whatever arrived on the wire.
 */

declare global {
  namespace Express {
    interface Request {
      validated: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
    }
  }
}

export interface ValidationSchemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

function formatIssues(error: ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    })),
  };
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.validated = {};

      if (schemas.params) req.validated.params = schemas.params.parse(req.params);
      if (schemas.query) req.validated.query = schemas.query.parse(req.query);
      if (schemas.body) req.validated.body = schemas.body.parse(req.body);

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const first = error.issues[0];
        const where = first?.path.join('.') || 'request';
        next(
          new ValidationError(
            `Invalid request: ${where} — ${first?.message ?? 'failed validation'}`,
            formatIssues(error),
          ),
        );
        return;
      }
      next(error);
    }
  };
}

/**
 * Typed accessors for validated input. These assert rather than check, because reaching a handler
 * with `req.validated` unpopulated means the route was wired without its `validate()` middleware —
 * a programming error that should fail loudly and immediately, not degrade at runtime.
 */
export function validatedBody<S extends ZodType>(req: Request): z.infer<S> {
  if (req.validated?.body === undefined) {
    throw new Error('validatedBody() called on a route with no body schema registered.');
  }
  return req.validated.body as z.infer<S>;
}

export function validatedQuery<S extends ZodType>(req: Request): z.infer<S> {
  if (req.validated?.query === undefined) {
    throw new Error('validatedQuery() called on a route with no query schema registered.');
  }
  return req.validated.query as z.infer<S>;
}

export function validatedParams<S extends ZodType>(req: Request): z.infer<S> {
  if (req.validated?.params === undefined) {
    throw new Error('validatedParams() called on a route with no params schema registered.');
  }
  return req.validated.params as z.infer<S>;
}
