import { createHash } from 'node:crypto';
import type { WagerPayload } from './wager-transaction.ts';

/** JSON with object keys sorted recursively (UTF-16 order, as RFC 8785), no whitespace; undefined fields are dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256 of the canonical business fields only; idempotency key, headers and transport envelope stay out. */
export function wagerPayloadHash(payload: WagerPayload): string {
  return sha256Hex(
    canonicalJson({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: payload.money.toJSON(),
      referenceExternalTransactionId: payload.referenceExternalTransactionId ?? undefined,
    }),
  );
}
