import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money.ts';
import { Wallet } from '../../../src/domain/wallet.ts';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry.ts';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/wager-transaction.ts';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvariantViolationError,
} from '../../../src/domain/errors/domain-errors.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const OPENED_AT = new Date('2026-11-09T10:00:00.000Z');
const LATER = new Date('2026-11-09T11:00:00.000Z');

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    at: OPENED_AT,
    openingTransactionId: 'opening-tx',
    openingEntryId: 'opening-entry',
  });
}

const entryRef = (n: number) => ({ entryId: `entry-${n}`, transactionId: `tx-${n}`, at: LATER });

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with the initial balance, not version 2 after an opening credit', () => {
      const { wallet } = openWallet('1000.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.updatedAt).toEqual(OPENED_AT);
    });

    it('produces a processed OPENING transaction and its CREDIT entry when the initial balance is positive', () => {
      const { wallet, opening } = openWallet('1000.00');
      expect(opening).toBeDefined();
      expect(opening!.transaction.kind).toBe(WagerTransactionKind.Opening);
      expect(opening!.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(opening!.transaction.observedBalance?.equals(brl('1000.00'))).toBe(true);
      expect(opening!.entry.direction).toBe(LedgerDirection.Credit);
      expect(opening!.entry.balanceBefore.isZero()).toBe(true);
      expect(opening!.entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(opening!.entry.transactionId).toBe(opening!.transaction.id);
    });

    it('produces no OPENING transaction and no ledger entry when the initial balance is zero', () => {
      const { wallet, opening } = openWallet('0.00');
      expect(opening).toBeUndefined();
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it('refuses a negative initial balance', () => {
      expect(() =>
        Wallet.open({
          id: 'w',
          playerId: 'p',
          initialBalance: brl('1.00').negate(),
          at: OPENED_AT,
          openingTransactionId: 't',
          openingEntryId: 'e',
        }),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('debit', () => {
    it('lowers the balance, bumps the version once and returns the matching DEBIT entry', () => {
      const { wallet } = openWallet('100.00');
      const entry = wallet.debit(brl('80.00'), entryRef(1));
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(LATER);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
    });

    it('allows a debit down to exactly zero', () => {
      const { wallet } = openWallet('80.00');
      wallet.debit(brl('80.00'), entryRef(1));
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('refuses to go negative and leaves balance, version and updatedAt untouched', () => {
      const { wallet } = openWallet('100.00');
      wallet.debit(brl('80.00'), entryRef(1));
      expect(() => wallet.debit(brl('80.00'), entryRef(2))).toThrow(InsufficientFundsError);
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(LATER);
    });

    it('refuses a debit in another currency without touching the version', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.debit(Money.from({ amount: '1.00', currency: 'USD' }), entryRef(1))).toThrow(
        CurrencyMismatchError,
      );
      expect(wallet.version).toBe(1);
    });

    it('refuses a zero amount because a movement without value would be a ledger line that moves nothing', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.debit(brl('0.00'), entryRef(1))).toThrow(InvariantViolationError);
      expect(wallet.version).toBe(1);
    });
  });

  describe('credit', () => {
    it('raises the balance, bumps the version once and returns the matching CREDIT entry', () => {
      const { wallet } = openWallet('0.00');
      const entry = wallet.credit(brl('25.50'), entryRef(1));
      expect(wallet.balance.equals(brl('25.50'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.isBalanced()).toBe(true);
    });

    it('refuses a credit in another currency', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }), entryRef(1))).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  it('rebuilds persisted state through rehydrate without re-running any rule', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      balance: brl('7.00'),
      version: 42,
      createdAt: OPENED_AT,
      updatedAt: LATER,
    });
    expect(wallet.version).toBe(42);
    expect(wallet.balance.amount).toBe('7.00');
  });

  it('keeps the balance equal to the sum of its ledger entries across a sequence of movements', () => {
    const { wallet, opening } = openWallet('100.00');
    const entries = [opening!.entry, wallet.debit(brl('30.00'), entryRef(1)), wallet.credit(brl('12.34'), entryRef(2))];
    entries.push(wallet.debit(brl('0.34'), entryRef(3)));
    const rebuilt = entries.reduce(
      (sum, e) => (e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money)),
      Money.zero('BRL'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(4);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    money: brl('10.00'),
    createdAt: LATER,
  };

  it('accepts a CREDIT whose after equals before plus money', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      balanceBefore: brl('5.00'),
      balanceAfter: brl('15.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects a DEBIT whose after does not equal before minus money', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        balanceBefore: brl('15.00'),
        balanceAfter: brl('15.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  it('rejects an entry whose balance after would be negative', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(InvariantViolationError);
  });

  it('rejects an entry mixing currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        balanceBefore: Money.from({ amount: '5.00', currency: 'USD' }),
        balanceAfter: Money.from({ amount: '15.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('cannot be modified after creation, not even through a cast', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      balanceBefore: brl('5.00'),
      balanceAfter: brl('15.00'),
    });
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow(TypeError);
    expect(entry.balanceAfter.amount).toBe('15.00');
  });

  it('reports an unbalanced rehydrated row instead of hiding it, so reconciliation can flag it', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      balanceBefore: brl('5.00'),
      balanceAfter: brl('16.00'),
    });
    expect(entry.isBalanced()).toBe(false);
  });
});
