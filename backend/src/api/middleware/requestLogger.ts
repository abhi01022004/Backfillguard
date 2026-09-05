import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../lib/logger';

declare global {
  namespace Express {
    interface Request {
      /** Correlates every log line for this request, including errors (R1.6). */
      requestId: string;
    }
  }
}

/**
 * Assigns a request id and logs completion with status and duration.
 * The id is echoed in the `x-request-id` response header so a UI error can be traced to a log line.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader('x-request-id', req.requestId);

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const context = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    };

    // Health polling is frequent and uninteresting; keep it at debug so real traffic stays visible.
    if (req.originalUrl.startsWith('/api/health')) {
      logger.debug('request', context);
    } else if (res.statusCode >= 500) {
      logger.error('request failed', context);
    } else if (res.statusCode >= 400) {
      logger.warn('request rejected', context);
    } else {
      logger.info('request', context);
    }
  });

  next();
}
