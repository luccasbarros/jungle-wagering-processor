import type { MoneyProps } from '../money.ts';
import type { Wallet } from '../wallet.ts';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry.ts';
import { type WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction.ts';
import type { FailureCode } from '../failure-codes.ts';
import { InvariantViolationError } from '../errors/domain-errors.ts';
import { type EventContext, IntegrationEvent } from './integration-event.ts';

interface WagerTransactionSummary {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export interface WagerTransactionProcessedData extends WagerTransactionSummary {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionSummary {
  failureCode: FailureCode;
  balance?: MoneyProps;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionSummary {
  referenceExternalTransactionId: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

const summary = (tx: WagerTransaction): WagerTransactionSummary => ({
  transactionId: tx.id,
  walletId: tx.walletId,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  kind: tx.kind,
  money: tx.money.toJSON(),
});

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) throw new InvariantViolationError(`transaction ${tx.id} is ${tx.status}, not ${expected}`);
}

// aggregateId is the wallet for every event: it becomes the FIFO MessageGroupId, so consumers see each wallet in order.
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...summary(tx),
        referenceTransactionId: tx.referenceTransactionId,
        balance: tx.observedBalance!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...summary(tx), failureCode: tx.failureCode!, balance: tx.observedBalance?.toJSON() },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...summary(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId! },
    });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
