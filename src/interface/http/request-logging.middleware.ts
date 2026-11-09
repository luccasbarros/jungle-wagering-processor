import { Injectable, type NestMiddleware } from '@nestjs/common';
import { logContext, type LogFields } from '../../application/log-context.ts';
import { NestPinoLogger } from '../../infrastructure/observability/logger.ts';
import { CORRELATION_HEADER, correlationIdFrom } from './http-contract.ts';

interface RequestLike {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
}

interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: 'finish', listener: () => void): void;
}

/** One context per request: every log line below carries its correlationId, and the completion line carries what the use case assigned. */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(private readonly logger: NestPinoLogger) {}

  use(req: RequestLike, res: ResponseLike, next: () => void): void {
    const header = req.headers[CORRELATION_HEADER];
    const correlationId = correlationIdFrom(typeof header === 'string' ? header : undefined);
    // The controller reads the header too; writing the resolved id back keeps a generated one identical in logs and events.
    req.headers[CORRELATION_HEADER] = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);

    const fields: LogFields = { correlationId };
    const started = performance.now();
    res.on('finish', () => {
      const durationMs = Math.round(performance.now() - started);
      this.logger.pino.info({ ...fields, method: req.method, path: req.originalUrl, statusCode: res.statusCode, durationMs }, 'request completed');
    });
    logContext.run(fields, next);
  }
}
