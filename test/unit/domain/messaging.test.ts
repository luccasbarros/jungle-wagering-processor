import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money.ts';
import { Wallet } from '../../../src/domain/wallet.ts';
import { WagerTransaction, WagerTransactionKind } from '../../../src/domain/wager-transaction.ts';
import { FailureCode } from '../../../src/domain/failure-codes.ts';
import { InboxMessage } from '../../../src/domain/inbox-message.ts';
import { OUTBOX_MAX_RETRY_DELAY_MS, OutboxMessage } from '../../../src/domain/outbox-message.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/domain/events/wager-events.ts';
import { InvariantViolationError } from '../../../src/domain/errors/domain-errors.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-11-09T12:00:00.000Z');
const context = { eventId: 'event-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: AT };

function setup(balance = '100.00', kind = WagerTransactionKind.Bet, extra: { referenceExternalTransactionId?: string } = {}) {
  const wallet = Wallet.rehydrate({ id: 'wallet-1', playerId: 'player-1', balance: brl(balance), version: 1, createdAt: AT, updatedAt: AT });
  const transaction = WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    createdAt: AT,
    ...extra,
  });
  const entry = transaction.applyTo(wallet, { entryId: 'entry-1', at: AT });
  return { wallet, transaction, entry };
}

describe('integration events', () => {
  it('carry eventType and version on the type and serialize an ISO envelope with money as decimal strings', () => {
    const { wallet, entry } = setup();
    const event = WalletBalanceChanged.from(wallet, entry!, context);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-11-09T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('describe a processed transaction with the balance it observed, keyed by wallet for per-wallet ordering', () => {
    const { transaction } = setup();
    const json = WagerTransactionProcessed.from(transaction, context).toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.aggregateId).toBe('wallet-1');
    expect(json.data.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(json.data.processedAt).toBe('2026-11-09T12:00:00.000Z');
  });

  it('describe a rejection with its failure code', () => {
    const { transaction } = setup('10.00');
    const json = WagerTransactionRejected.from(transaction, context).toJSON();
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(json.data.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('describe a transaction waiting for its reference', () => {
    const { transaction } = setup('100.00', WagerTransactionKind.Refund, { referenceExternalTransactionId: 'bet-1' });
    const json = WagerTransactionPendingReference.from(transaction, context).toJSON();
    expect(json.data.referenceExternalTransactionId).toBe('bet-1');
  });

  it('refuse to describe a transaction in a status the event does not represent', () => {
    const { transaction } = setup('10.00');
    expect(() => WagerTransactionProcessed.from(transaction, context)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(transaction, context)).toThrow(InvariantViolationError);
    const processed = setup().transaction;
    expect(() => WagerTransactionRejected.from(processed, context)).toThrow(InvariantViolationError);
  });

  it('omit causationId from the envelope when there is none', () => {
    const { transaction } = setup();
    const json = WagerTransactionProcessed.from(transaction, { ...context, causationId: undefined }).toJSON();
    expect('causationId' in JSON.parse(JSON.stringify(json))).toBe(false);
  });
});

describe('OutboxMessage', () => {
  const enqueue = () => {
    const { transaction } = setup();
    return OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context));
  };

  it('stores the serialized envelope under the event id, so a duplicate publish carries the same dedup id', () => {
    const message = enqueue();
    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload.occurredAt).toBe('2026-11-09T12:00:00.000Z');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(AT)).toBe(true);
  });

  it('backs off exponentially from 2 s and caps the delay at 5 minutes', () => {
    const message = enqueue();
    const delays: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      message.scheduleRetry(AT);
      delays.push(message.nextAttemptAt!.getTime() - AT.getTime());
    }
    expect(delays.slice(0, 5)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(Math.max(...delays)).toBe(OUTBOX_MAX_RETRY_DELAY_MS);
    expect(delays.at(-1)).toBe(300_000);
    expect(message.attempts).toBe(12);
  });

  it('is not due before its next attempt time and is due from it on', () => {
    const message = enqueue();
    message.scheduleRetry(AT);
    expect(message.isDue(new Date(AT.getTime() + 1_999))).toBe(false);
    expect(message.isDue(new Date(AT.getTime() + 2_000))).toBe(true);
  });

  it('stops being pending or due once published, and refuses a second publish mark', () => {
    const message = enqueue();
    message.markPublished(AT);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(AT)).toBe(false);
    expect(message.publishedAt).toEqual(AT);
    expect(() => message.markPublished(AT)).toThrow(InvariantViolationError);
  });
});

describe('InboxMessage', () => {
  it('is received unprocessed and becomes processed once', () => {
    const message = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: AT });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(AT);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(AT);
    expect(() => message.markProcessed(AT)).toThrow(InvariantViolationError);
  });
});
