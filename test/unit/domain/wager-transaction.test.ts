import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money.ts';
import { Wallet } from '../../../src/domain/wallet.ts';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry.ts';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wager-transaction.ts';
import { FailureCode } from '../../../src/domain/failure-codes.ts';
import {
  DomainError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from '../../../src/domain/errors/domain-errors.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-11-09T12:00:00.000Z');

let seq = 0;
function tx(kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  seq += 1;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    createdAt: AT,
    ...overrides,
  });
}

function processedRef(kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const ref = tx(kind, kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: 'x', ...overrides } : overrides);
  ref.markProcessed(undefined, AT, brl('0.00'));
  return ref;
}

const reversalOf = (kind: Kind.Refund | Kind.Rollback, reference: WagerTransaction, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  tx(kind, { referenceExternalTransactionId: reference.externalTransactionId, money: reference.money, ...overrides });

function wallet(balance = '100.00', overrides: { id?: string; playerId?: string } = {}): Wallet {
  return Wallet.rehydrate({
    id: overrides.id ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    balance: brl(balance),
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  });
}

// BET is the one kind that refuses a reference outright; the others accept one for the table-driven checks.
const refIfAllowed = (kind: Kind) => (kind === Kind.Bet ? {} : { referenceExternalTransactionId: 'ref' });

let entrySeq = 0;
const ctx = (extra: { reference?: WagerTransaction; referenceAlreadyReversed?: boolean } = {}) => {
  entrySeq += 1;
  return { entryId: `entry-${entrySeq}`, at: AT, ...extra };
};

describe('WagerTransaction', () => {
  describe('create', () => {
    it('starts PENDING with no failure code, reference id or processedAt', () => {
      const bet = tx(Kind.Bet);
      expect(bet.status).toBe(Status.Pending);
      expect(bet.failureCode).toBeUndefined();
      expect(bet.referenceTransactionId).toBeUndefined();
      expect(bet.processedAt).toBeUndefined();
      expect(bet.isTerminal()).toBe(false);
    });

    it('refuses OPENING with KIND_NOT_SUBMITTABLE, so the internal kind never enters through the API or the queue', () => {
      expect(() => tx(Kind.Opening)).toThrow(DomainError);
      try {
        tx(Kind.Opening);
      } catch (error) {
        expect((error as DomainError).code).toBe(FailureCode.KindNotSubmittable);
      }
    });

    it.each([Kind.Refund, Kind.Rollback])('refuses %s without a referenceExternalTransactionId as an invalid payload', (kind) => {
      try {
        tx(kind);
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe(FailureCode.InvalidPayload);
      }
    });

    it.each([Kind.Refund, Kind.Rollback])('refuses %s that references itself as an invalid payload, instead of waiting out the TTL', (kind) => {
      try {
        tx(kind, { externalTransactionId: 'ext-self', referenceExternalTransactionId: 'ext-self' });
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe(FailureCode.InvalidPayload);
      }
    });

    it('refuses a BET with a reference as an invalid payload, because no rule gives it a meaning', () => {
      try {
        tx(Kind.Bet, { referenceExternalTransactionId: 'ref' });
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe(FailureCode.InvalidPayload);
      }
    });

    it.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])('refuses a zero amount on %s', (kind) => {
      expect(() => tx(kind, { money: brl('0.00'), ...refIfAllowed(kind) })).toThrow(InvalidMoneyError);
    });

    it('accepts a zero amount on LOSS because it only records the outcome', () => {
      expect(tx(Kind.Loss, { money: brl('0.00') }).status).toBe(Status.Pending);
    });

    it('refuses a negative amount built by negate', () => {
      expect(() => tx(Kind.Win, { money: brl('1.00').negate() })).toThrow(InvalidMoneyError);
    });
  });

  describe('kind rules', () => {
    it.each([
      [Kind.Bet, false],
      [Kind.Win, false],
      [Kind.Loss, false],
      [Kind.Refund, true],
      [Kind.Rollback, true],
    ])('%s requires a reference: %p', (kind, expected) => {
      expect(tx(kind, refIfAllowed(kind)).requiresReference()).toBe(expected);
    });

    it.each([
      [Kind.Bet, true],
      [Kind.Win, true],
      [Kind.Loss, false],
      [Kind.Refund, true],
      [Kind.Rollback, true],
    ])('%s affects the balance: %p', (kind, expected) => {
      expect(tx(kind, refIfAllowed(kind)).affectsBalance()).toBe(expected);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Debit],
      [Kind.Win, LedgerDirection.Credit],
      [Kind.Refund, LedgerDirection.Credit],
    ])('moves %s in the %s direction', (kind, direction) => {
      expect(tx(kind, refIfAllowed(kind)).ledgerDirectionFor(processedRef(Kind.Bet))).toBe(direction);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Credit],
      [Kind.Win, LedgerDirection.Debit],
      [Kind.Refund, LedgerDirection.Debit],
    ])('moves a ROLLBACK of %s in the opposite direction, %s', (refKind, direction) => {
      const rollback = tx(Kind.Rollback, { referenceExternalTransactionId: 'ref' });
      expect(rollback.ledgerDirectionFor(processedRef(refKind))).toBe(direction);
    });

    it('cannot pick a direction for a ROLLBACK without its reference', () => {
      expect(() => tx(Kind.Rollback, { referenceExternalTransactionId: 'ref' }).ledgerDirectionFor()).toThrow(InvariantViolationError);
    });

    it('has no ledger direction for LOSS because it never moves money', () => {
      expect(() => tx(Kind.Loss).ledgerDirectionFor()).toThrow(InvariantViolationError);
    });
  });

  describe('status machine', () => {
    type Transition = [string, (t: WagerTransaction) => void];
    const transitions: Transition[] = [
      ['markProcessed', (t) => t.markProcessed(undefined, AT, brl('1.00'))],
      ['markPendingReference', (t) => t.markPendingReference(brl('1.00'))],
      ['reject', (t) => t.reject(FailureCode.InsufficientFunds, brl('1.00'))],
      ['fail', (t) => t.fail(FailureCode.PermanentFailure)],
    ];
    const terminal: Transition[] = transitions.filter(([name]) => name !== 'markPendingReference');

    for (const [toTerminal, enter] of terminal) {
      for (const [name, run] of transitions) {
        it(`throws InvalidTransactionStateError on ${name} after ${toTerminal}, because terminal states never move`, () => {
          const t = tx(Kind.Bet);
          enter(t);
          const before = t.status;
          expect(() => run(t)).toThrow(InvalidTransactionStateError);
          expect(t.status).toBe(before);
        });
      }
    }

    it('moves PENDING to PENDING_REFERENCE, stays there on a retry and then reaches PROCESSED', () => {
      const t = tx(Kind.Refund, { referenceExternalTransactionId: 'ref' });
      t.markPendingReference(brl('5.00'));
      t.markPendingReference(brl('6.00'));
      expect(t.status).toBe(Status.PendingReference);
      expect(t.observedBalance?.amount).toBe('6.00');
      t.markProcessed('ref-id', AT, brl('31.00'));
      expect(t.status).toBe(Status.Processed);
      expect(t.referenceTransactionId).toBe('ref-id');
      expect(t.processedAt).toEqual(AT);
    });

    describe('pending-reference retry', () => {
      const policy = { maxAttempts: 3, ttlMs: 60_000, baseDelayMs: 2_000, maxDelayMs: 5_000 };
      const pending = () => {
        const t = tx(Kind.Refund, { referenceExternalTransactionId: 'ref' });
        t.markPendingReference(brl('5.00'));
        return t;
      };
      const secondsAfter = (t: WagerTransaction, from: Date) => (t.nextRetryAt!.getTime() - from.getTime()) / 1000;

      it('starts with zero attempts and no retry due date', () => {
        const t = pending();
        expect(t.retryAttempts).toBe(0);
        expect(t.nextRetryAt).toBeUndefined();
      });

      it('doubles the delay on each retry and caps it at the policy maximum', () => {
        const t = pending();
        t.scheduleRetry(AT, policy);
        expect(t.retryAttempts).toBe(1);
        expect(secondsAfter(t, AT)).toBe(4);
        t.scheduleRetry(AT, policy);
        expect(secondsAfter(t, AT)).toBe(5);
        expect(t.status).toBe(Status.PendingReference);
      });

      it('is exhausted once the attempts reach the cap, even while still young', () => {
        const t = pending();
        for (let i = 0; i < policy.maxAttempts - 1; i++) t.scheduleRetry(AT, policy);
        expect(t.hasExhaustedRetries(AT, policy)).toBe(false);
        t.scheduleRetry(AT, policy);
        expect(t.hasExhaustedRetries(AT, policy)).toBe(true);
      });

      it('is exhausted once it is older than the TTL, even with attempts to spare', () => {
        const t = pending();
        expect(t.hasExhaustedRetries(new Date(AT.getTime() + policy.ttlMs - 1), policy)).toBe(false);
        expect(t.hasExhaustedRetries(new Date(AT.getTime() + policy.ttlMs), policy)).toBe(true);
      });

      it('refuses to schedule a retry for a transaction that is not waiting for its reference', () => {
        const t = tx(Kind.Bet);
        expect(() => t.scheduleRetry(AT, policy)).toThrow(InvalidTransactionStateError);
      });

      it('keeps the retry counters through rehydrate', () => {
        const t = pending();
        t.scheduleRetry(AT, policy);
        const back = WagerTransaction.rehydrate(t.toState());
        expect(back.retryAttempts).toBe(1);
        expect(back.nextRetryAt).toEqual(t.nextRetryAt);
      });
    });

    it('records the failure code and the balance seen at rejection, for the idempotent replay', () => {
      const t = tx(Kind.Bet);
      t.reject(FailureCode.InsufficientFunds, brl('20.00'));
      expect(t.status).toBe(Status.Rejected);
      expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(t.observedBalance?.amount).toBe('20.00');
    });

    it('marks an infrastructure dead end as FAILED, not REJECTED', () => {
      const t = tx(Kind.Bet);
      t.fail(FailureCode.PermanentFailure);
      expect(t.status).toBe(Status.Failed);
      expect(t.failureCode).toBe(FailureCode.PermanentFailure);
    });

    it('rebuilds persisted state with rehydrate even where create would refuse it', () => {
      const opening = tx(Kind.Bet);
      const state = { ...opening.toState(), kind: Kind.Opening, status: Status.Processed, processedAt: AT };
      const rebuilt = WagerTransaction.rehydrate(state);
      expect(rebuilt.kind).toBe(Kind.Opening);
      expect(rebuilt.status).toBe(Status.Processed);
      expect(rebuilt.payloadHash).toBe(opening.payloadHash);
    });
  });

  describe('applyTo', () => {
    describe('BET', () => {
      it('debits the wallet, returns the DEBIT entry and ends PROCESSED with the balance it saw', () => {
        const w = wallet('100.00');
        const bet = tx(Kind.Bet, { money: brl('25.00') });
        const entry = bet.applyTo(w, ctx());
        expect(entry?.direction).toBe(LedgerDirection.Debit);
        expect(entry?.transactionId).toBe(bet.id);
        expect(w.balance.amount).toBe('75.00');
        expect(bet.status).toBe(Status.Processed);
        expect(bet.observedBalance?.amount).toBe('75.00');
        expect(bet.processedAt).toEqual(AT);
      });

      it('is REJECTED with INSUFFICIENT_FUNDS and leaves the wallet untouched when the balance is short', () => {
        const w = wallet('10.00');
        const bet = tx(Kind.Bet, { money: brl('25.00') });
        expect(bet.applyTo(w, ctx())).toBeUndefined();
        expect(bet.status).toBe(Status.Rejected);
        expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
        expect(bet.observedBalance?.amount).toBe('10.00');
        expect(w.version).toBe(1);
      });

      it('processes exactly one of two 80.00 bets on a 100.00 balance and leaves 20.00', () => {
        const w = wallet('100.00');
        const first = tx(Kind.Bet, { money: brl('80.00') });
        const second = tx(Kind.Bet, { money: brl('80.00') });
        const entries = [first.applyTo(w, ctx()), second.applyTo(w, ctx())].filter(Boolean);
        expect([first.status, second.status]).toEqual([Status.Processed, Status.Rejected]);
        expect(entries).toHaveLength(1);
        expect(w.balance.amount).toBe('20.00');
      });
    });

    describe('WIN', () => {
      it('credits the wallet', () => {
        const w = wallet('0.00');
        const entry = tx(Kind.Win, { money: brl('50.00') }).applyTo(w, ctx());
        expect(entry?.direction).toBe(LedgerDirection.Credit);
        expect(w.balance.amount).toBe('50.00');
      });

      it('credits when it references a processed BET of the same round and links to it', () => {
        const w = wallet('100.00');
        const bet = processedRef(Kind.Bet);
        const win = tx(Kind.Win, { referenceExternalTransactionId: bet.externalTransactionId });
        win.applyTo(w, ctx({ reference: bet }));
        expect(win.status).toBe(Status.Processed);
        expect(win.referenceTransactionId).toBe(bet.id);
      });
    });

    describe('LOSS', () => {
      it('ends PROCESSED without a ledger entry and without touching balance, version or updatedAt', () => {
        const w = wallet('100.00');
        const loss = tx(Kind.Loss, { money: brl('0.00') });
        expect(loss.applyTo(w, ctx())).toBeUndefined();
        expect(loss.status).toBe(Status.Processed);
        expect(loss.observedBalance?.amount).toBe('100.00');
        expect(w.balance.amount).toBe('100.00');
        expect(w.version).toBe(1);
        expect(w.updatedAt).toEqual(AT);
      });
    });

    describe('REFUND', () => {
      it('credits back a processed BET and links the reference id', () => {
        const w = wallet('75.00');
        const bet = processedRef(Kind.Bet);
        const refund = reversalOf(Kind.Refund, bet);
        const entry = refund.applyTo(w, ctx({ reference: bet }));
        expect(entry?.direction).toBe(LedgerDirection.Credit);
        expect(w.balance.amount).toBe('100.00');
        expect(refund.referenceTransactionId).toBe(bet.id);
      });

      it.each([Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])('is REJECTED with REFERENCE_KIND_NOT_ALLOWED when it points at a %s', (refKind) => {
        const ref = processedRef(refKind);
        const refund = reversalOf(Kind.Refund, ref, { money: brl('25.00') });
        refund.applyTo(wallet(), ctx({ reference: ref }));
        expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
      });
    });

    describe('ROLLBACK', () => {
      it('debits back a processed WIN', () => {
        const w = wallet('100.00');
        const win = processedRef(Kind.Win);
        const rollback = reversalOf(Kind.Rollback, win);
        const entry = rollback.applyTo(w, ctx({ reference: win }));
        expect(entry?.direction).toBe(LedgerDirection.Debit);
        expect(w.balance.amount).toBe('75.00');
      });

      it('credits back a processed BET', () => {
        const w = wallet('75.00');
        const bet = processedRef(Kind.Bet);
        reversalOf(Kind.Rollback, bet).applyTo(w, ctx({ reference: bet }));
        expect(w.balance.amount).toBe('100.00');
      });

      it('is REJECTED with REVERSAL_WOULD_OVERDRAW, distinct from a BET without funds, when undoing a WIN would go negative', () => {
        const w = wallet('10.00');
        const win = processedRef(Kind.Win);
        const rollback = reversalOf(Kind.Rollback, win);
        expect(rollback.applyTo(w, ctx({ reference: win }))).toBeUndefined();
        expect(rollback.status).toBe(Status.Rejected);
        expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
        expect(w.balance.amount).toBe('10.00');
      });

      it.each([Kind.Loss, Kind.Rollback])('is REJECTED with REFERENCE_KIND_NOT_ALLOWED when it points at a %s', (refKind) => {
        const ref = processedRef(refKind);
        const rollback = reversalOf(Kind.Rollback, ref, { money: brl('25.00') });
        rollback.applyTo(wallet(), ctx({ reference: ref }));
        expect(rollback.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
      });
    });

    describe('reference resolution', () => {
      it('waits in PENDING_REFERENCE when the reference has not arrived and processes once it does', () => {
        const w = wallet('75.00');
        const bet = processedRef(Kind.Bet);
        const refund = reversalOf(Kind.Refund, bet);
        expect(refund.applyTo(w, ctx())).toBeUndefined();
        expect(refund.status).toBe(Status.PendingReference);
        expect(w.version).toBe(1);
        refund.applyTo(w, ctx({ reference: bet }));
        expect(refund.status).toBe(Status.Processed);
        expect(w.balance.amount).toBe('100.00');
      });

      it('treats a reference that is itself still pending as absent', () => {
        const bet = tx(Kind.Bet);
        const refund = reversalOf(Kind.Refund, bet);
        refund.applyTo(wallet(), ctx({ reference: bet }));
        expect(refund.status).toBe(Status.PendingReference);
      });

      it.each([
        ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, brl('0.00'))],
        ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.PermanentFailure)],
      ])('is REJECTED with REFERENCE_NOT_PROCESSED when the reference is %s', (_label, settle) => {
        const bet = tx(Kind.Bet);
        settle(bet);
        const refund = reversalOf(Kind.Refund, bet);
        refund.applyTo(wallet(), ctx({ reference: bet }));
        expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
      });

      it.each([
        ['provider', { providerId: 'provider-b' }],
        ['player', { playerId: 'player-2' }],
        ['wallet', { walletId: 'wallet-2' }],
        ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
        ['round', { roundId: 'round-2' }],
      ])('is REJECTED with REFERENCE_SCOPE_MISMATCH when the reference belongs to another %s', (_label, scope) => {
        const bet = processedRef(Kind.Bet, scope);
        const refund = reversalOf(Kind.Refund, bet, { money: brl('25.00') });
        refund.applyTo(wallet(), ctx({ reference: bet }));
        expect(refund.status).toBe(Status.Rejected);
        expect(refund.failureCode).toBe(FailureCode.ReferenceScopeMismatch);
      });

      it('is REJECTED with AMOUNT_MISMATCH on a partial reversal', () => {
        const bet = processedRef(Kind.Bet, { money: brl('25.00') });
        const refund = reversalOf(Kind.Refund, bet, { money: brl('10.00') });
        refund.applyTo(wallet(), ctx({ reference: bet }));
        expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
      });

      it.each([Kind.Refund, Kind.Rollback] as const)(
        'is REJECTED with REFERENCE_ALREADY_REVERSED when the BET already has a processed reversal of any kind (%s second)',
        (kind) => {
          const w = wallet('75.00');
          const bet = processedRef(Kind.Bet);
          const second = reversalOf(kind, bet);
          expect(second.applyTo(w, ctx({ reference: bet, referenceAlreadyReversed: true }))).toBeUndefined();
          expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
          expect(w.balance.amount).toBe('75.00');
        },
      );

      it('refuses a reference whose external id is not the one the transaction names', () => {
        const bet = processedRef(Kind.Bet);
        const refund = tx(Kind.Refund, { referenceExternalTransactionId: 'someone-else', money: bet.money });
        expect(() => refund.applyTo(wallet(), ctx({ reference: bet }))).toThrow(InvariantViolationError);
      });
    });

    describe('wallet checks', () => {
      it('is REJECTED with CURRENCY_MISMATCH when the transaction currency differs from the wallet', () => {
        const w = wallet('100.00');
        const bet = tx(Kind.Bet, { money: Money.from({ amount: '1.00', currency: 'USD' }) });
        bet.applyTo(w, ctx());
        expect(bet.status).toBe(Status.Rejected);
        expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
        expect(w.version).toBe(1);
      });

      it('is REJECTED with WALLET_PLAYER_MISMATCH when the wallet belongs to another player', () => {
        const bet = tx(Kind.Bet);
        bet.applyTo(wallet('100.00', { playerId: 'player-2' }), ctx());
        expect(bet.failureCode).toBe(FailureCode.WalletPlayerMismatch);
      });

      it('refuses to run against a wallet other than the one it targets', () => {
        expect(() => tx(Kind.Bet).applyTo(wallet('100.00', { id: 'wallet-9' }), ctx())).toThrow(InvariantViolationError);
      });

      it('refuses to run again once terminal, so a retry cannot debit twice', () => {
        const w = wallet('100.00');
        const bet = tx(Kind.Bet);
        bet.applyTo(w, ctx());
        expect(() => bet.applyTo(w, ctx())).toThrow(InvalidTransactionStateError);
        expect(w.balance.amount).toBe('75.00');
      });
    });
  });

  describe('opening', () => {
    it('builds a PROCESSED internal OPENING credit with a deterministic idempotency key per wallet', () => {
      const opening = WagerTransaction.opening({ id: 'o', walletId: 'w', playerId: 'p', money: brl('10.00'), at: AT });
      expect(opening.kind).toBe(Kind.Opening);
      expect(opening.status).toBe(Status.Processed);
      expect(opening.idempotencyKey).toBe('internal:opening:w');
      expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });
});
