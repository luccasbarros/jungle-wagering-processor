import { Money } from './money.ts';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.ts';
import { WagerTransaction } from './wager-transaction.ts';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvariantViolationError,
} from './errors/domain-errors.ts';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  openingTransactionId: string;
  openingEntryId: string;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Present only when the initial balance is positive. */
  opening?: { transaction: WagerTransaction; entry: WalletLedgerEntry };
}

/** Identity of the ledger line a movement produces; ids come from the application, the domain never mints them. */
export interface MovementRef {
  entryId: string;
  transactionId: string;
  at: Date;
}

const INITIAL_VERSION = 1;

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Born with the initial balance at version 1; the OPENING credit is part of birth, not a later movement. */
  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, at } = props;
    if (initialBalance.isNegative()) throw new InvalidMoneyError('initial balance must not be negative');
    const wallet = new Wallet(id, playerId, initialBalance, INITIAL_VERSION, at, at);
    if (initialBalance.isZero()) return { wallet };

    const transaction = WagerTransaction.opening({
      id: props.openingTransactionId,
      walletId: id,
      playerId,
      money: initialBalance,
      at,
    });
    const entry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });
    return { wallet, opening: { transaction, entry } };
  }

  /** Rebuilds persisted state; does not revalidate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get currency(): string {
    return this._balance.currency;
  }

  debit(money: Money, ref: MovementRef): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, money, ref);
  }

  credit(money: Money, ref: MovementRef): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, money, ref);
  }

  // The entry is built (and validated) before any field changes, so a refused movement leaves no trace.
  private move(direction: LedgerDirection, money: Money, ref: MovementRef): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new InvariantViolationError('movement amount must be positive');
    const after = direction === LedgerDirection.Debit ? this._balance.subtract(money) : this._balance.add(money);
    if (after.isNegative()) throw new InsufficientFundsError();

    const entry = WalletLedgerEntry.create({
      id: ref.entryId,
      walletId: this.id,
      transactionId: ref.transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: ref.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = ref.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
