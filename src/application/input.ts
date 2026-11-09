import { Money, type MoneyProps } from '../domain/money.ts';
import { FailureCode } from '../domain/failure-codes.ts';
import { DomainError } from '../domain/errors/domain-errors.ts';
import { WagerTransactionKind, type WagerPayload } from '../domain/wager-transaction.ts';

// Bounded so an oversized id fails here as 400 instead of in a btree index as 500.
const MAX_TEXT_LENGTH = 255;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTABLE_KINDS: readonly string[] = Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening);

const invalid = (message: string) => new DomainError(FailureCode.InvalidPayload, message);

type Body = Record<string, unknown>;

function asBody(value: unknown): Body {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('body must be a JSON object');
  return value as Body;
}

function text(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw invalid(`${field} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

export function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

export function parseIdempotencyKey(value: unknown): string {
  if (value === undefined || value === '') throw new DomainError(FailureCode.MissingIdempotencyKey, 'Idempotency-Key header is required');
  return text({ 'Idempotency-Key': value }, 'Idempotency-Key');
}

/** Shape check of a submission; Money and the per-kind rules are the domain's. */
export function parseWagerPayload(value: unknown): WagerPayload {
  const body = asBody(value);
  if (body.kind === WagerTransactionKind.Opening) {
    throw new DomainError(FailureCode.KindNotSubmittable, 'OPENING is internal and cannot be submitted');
  }
  if (typeof body.kind !== 'string' || !SUBMITTABLE_KINDS.includes(body.kind)) {
    throw invalid(`kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }
  const reference = body.referenceExternalTransactionId;
  return {
    providerId: text(body, 'providerId'),
    externalTransactionId: text(body, 'externalTransactionId'),
    playerId: text(body, 'playerId'),
    walletId: parseUuid(body.walletId, 'walletId'),
    roundId: text(body, 'roundId'),
    gameId: text(body, 'gameId'),
    kind: body.kind as WagerTransactionKind,
    money: Money.from(body.money as MoneyProps),
    referenceExternalTransactionId: reference === undefined || reference === null ? undefined : text(body, 'referenceExternalTransactionId'),
  };
}

const DEFAULT_LEDGER_PAGE_SIZE = 50;
const MAX_LEDGER_PAGE_SIZE = 200;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
// BIGINT ceiling: a larger position would fail inside the query as 500 instead of here as 400.
const MAX_LEDGER_SEQ = 2n ** 63n - 1n;

export interface LedgerPageQuery {
  beforeSeq?: string;
  limit: number;
}

export function parseLedgerPage(cursor: unknown, limit: unknown): LedgerPageQuery {
  if (limit !== undefined && (typeof limit !== 'string' || !POSITIVE_INTEGER.test(limit) || Number(limit) > MAX_LEDGER_PAGE_SIZE)) {
    throw invalid(`limit must be an integer from 1 to ${MAX_LEDGER_PAGE_SIZE}`);
  }
  const size = limit === undefined ? DEFAULT_LEDGER_PAGE_SIZE : Number(limit);
  if (cursor === undefined) return { limit: size };
  const seq = typeof cursor === 'string' ? Buffer.from(cursor, 'base64url').toString() : '';
  if (!POSITIVE_INTEGER.test(seq) || BigInt(seq) > MAX_LEDGER_SEQ) throw invalid('cursor is not a ledger position handed out by this API');
  return { beforeSeq: seq, limit: size };
}

/** Opaque to clients: they echo it back, never build it. */
export const encodeLedgerCursor = (seq: string): string => Buffer.from(seq).toString('base64url');

export function parseCreateWallet(value: unknown): { playerId: string; initialBalance: Money } {
  const body = asBody(value);
  return { playerId: text(body, 'playerId'), initialBalance: Money.from(body.initialBalance as MoneyProps) };
}
