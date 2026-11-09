import pino, { type DestinationStream, type Level, type Logger } from 'pino';
import type { LoggerService } from '@nestjs/common';
import { logContext } from '../../application/log-context.ts';

const MONEY_FIELDS = ['money', 'amount', 'balance', 'initialBalance', 'observedBalance', 'balanceBefore', 'balanceAfter'];

// ponytail: safety net under the identifiers-only log context, three levels deep (an event's data.money); deeper nesting leaks.
export const REDACTED_PATHS = MONEY_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]);

export interface LoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export function createLogger({ level = process.env.LOG_LEVEL ?? 'info', destination }: LoggerOptions = {}): Logger {
  return pino(
    {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => ({ ...logContext.current() }),
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}

/** Routes Nest's own logs (bootstrap, error filter) through the same JSON logger and request context. */
export class NestPinoLogger implements LoggerService {
  constructor(readonly pino: Logger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  // Nest appends the logger's context name as the last argument.
  private write(level: Level, message: unknown, rest: unknown[]): void {
    const context = rest.at(-1);
    if (message instanceof Error) this.pino[level]({ context, err: message }, message.message);
    else this.pino[level]({ context }, String(message));
  }
}
