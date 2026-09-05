import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorBody } from '@bg/shared';
import { ERROR_CODE } from '@bg/shared';
import { isProduction } from '../../config/env';
import { logger } from '../../lib/logger';
import { NotFoundError, toAppError } from '../../lib/errors';

/** 404 handler for unmatched routes, so an unknown path still returns the standard envelope. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}.`));
}

/**
 * Terminal error handler (R1.6, R23.2, R23.7).
 *
 * Every failure leaves the API as a structured envelope with a machine-readable code, and every
 * failure is logged with its request id. Stack traces are attached only outside production; a
 * non-operational error (a bug, a database failure) also has its message replaced with a generic one
 * so internals never leak to a client.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Delegate to Express if the response is already streaming — nothing useful we can add.
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = toAppError(error);

  const logContext = {
    requestId: req.requestId,
    code: appError.code,
    status: appError.httpStatus,
    path: req.originalUrl,
    details: appError.details,
  };

  if (appError.isOperational) {
    logger.warn(`handled: ${appError.message}`, logContext);
  } else {
    logger.error(`unhandled: ${appError.message}`, {
      ...logContext,
      stack: appError.stack,
      cause: appError.cause instanceof Error ? appError.cause.message : appError.cause,
    });
  }

  const clientMessage =
    appError.isOperational || !isProduction
      ? appError.message
      : 'An internal error occurred. Check the server logs for details.';

  const body: ApiErrorBody = {
    error: {
      code: appError.code ?? ERROR_CODE.INTERNAL_ERROR,
      message: clientMessage,
      ...(appError.details ? { details: appError.details } : {}),
      ...(isProduction ? {} : { stack: appError.stack }),
    },
  };

  res.status(appError.httpStatus).json(body);
}
