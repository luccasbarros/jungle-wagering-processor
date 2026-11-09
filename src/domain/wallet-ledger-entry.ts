import { Money } from './money.ts';
import { CurrencyMismatchError, InvariantViolationError } from './errors/domain-errors.ts';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export const oppositeOf = (direction: LedgerDirection): LedgerDirection =>
  direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly direction: LedgerDirection;
  public readonly money: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  public readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAt = state.createdAt;
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    for (const other of [props.balanceBefore, props.balanceAfter]) {
      if (other.currency !== props.money.currency) throw new CurrencyMismatchError(props.money.currency, other.currency);
    }
    if (!props.money.isPositive()) throw new InvariantViolationError('ledger entry amount must be positive');
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger entry balances must not be negative');
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `unbalanced ledger entry: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
