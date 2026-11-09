import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { DomainError } from '../../domain/errors/domain-errors.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { TransientFailureError, safeReason, safeStack } from '../../application/errors.ts';
import { HTTP_STATUS_BY_FAILURE_CODE, RETRY_AFTER_SECONDS, UNMAPPED_DOMAIN_ERROR_STATUS } from './http-contract.ts';

interface HttpError {
  status: number;
  body: { failureCode?: FailureCode; message: string };
}

interface ResponseLike {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const { status, body } = toHttpError(error);
    if (status === 500) this.logger.error(safeReason(error), safeStack(error));
    const response = host.switchToHttp().getResponse<ResponseLike>();
    if (status === 503) response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    response.status(status).json(body);
  }
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof DomainError) {
    return { status: HTTP_STATUS_BY_FAILURE_CODE[error.code] ?? UNMAPPED_DOMAIN_ERROR_STATUS, body: { failureCode: error.code, message: error.message } };
  }
  if (error instanceof TransientFailureError) {
    return { status: 503, body: { failureCode: error.code, message: 'temporarily unavailable, retry the same request' } };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    // Framework-level 400s (malformed JSON body) speak the same contract as ours.
    return { status, body: { ...(status === 400 ? { failureCode: FailureCode.InvalidPayload } : {}), message: error.message } };
  }
  return { status: 500, body: { message: 'internal error' } };
}
