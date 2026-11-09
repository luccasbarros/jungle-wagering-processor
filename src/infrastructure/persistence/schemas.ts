import { EntitySchema } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money.ts';
import { Wallet } from '../../domain/wallet.ts';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction.ts';
import type { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import type { FailureCode } from '../../domain/failure-codes.ts';
import type { OutboxMessage } from '../../domain/outbox-message.ts';
import type { InboxMessage } from '../../domain/inbox-message.ts';

// Records mirror the columns; NUMERIC stays a string end to end and only becomes Money through Money.from.

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'text' },
    currency: { type: 'string' },
    balance: { type: 'decimal', precision: 19, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  observedBalance: string | null;
  observedBalanceCurrency: string | null;
  retryAttempts: number;
  nextRetryAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'text' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    status: { type: 'text' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'text', nullable: true },
    observedBalance: { type: 'decimal', precision: 19, scale: 2, nullable: true },
    observedBalanceCurrency: { type: 'string', nullable: true },
    retryAttempts: { type: 'integer' },
    nextRetryAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  currency: string;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    balanceBefore: { type: 'decimal', precision: 19, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string' },
    createdAt: { type: 'datetime' },
  },
});

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true },
    publishedAt: { type: 'datetime', nullable: true },
  },
});

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'text' },
    receivedAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export const ENTITY_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, OutboxSchema, InboxSchema];

export const walletToDomain = (record: WalletRecord): Wallet =>
  Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

export const walletToRecord = (wallet: Wallet): WalletRecord => ({
  id: wallet.id,
  playerId: wallet.playerId,
  currency: wallet.currency,
  balance: wallet.balance.amount,
  version: wallet.version,
  createdAt: wallet.createdAt,
  updatedAt: wallet.updatedAt,
});

/** Columns a decision writes; retry_attempts/next_retry_at belong to the pending-reference worker and are left alone. */
export function transactionOutcome(transaction: WagerTransaction) {
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    observedBalance: transaction.observedBalance?.amount ?? null,
    observedBalanceCurrency: transaction.observedBalance?.currency ?? null,
    processedAt: transaction.processedAt ?? null,
  };
}

export const transactionToRecord = (transaction: WagerTransaction): WagerTransactionRecord => ({
  id: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  idempotencyKey: transaction.idempotencyKey,
  payloadHash: transaction.payloadHash,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  amount: transaction.money.amount,
  currency: transaction.money.currency,
  referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
  retryAttempts: 0,
  nextRetryAt: null,
  createdAt: transaction.createdAt,
  ...transactionOutcome(transaction),
});

export const transactionToDomain = (record: WagerTransactionRecord): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    observedBalance:
      record.observedBalance === null || record.observedBalanceCurrency === null
        ? undefined
        : Money.from({ amount: record.observedBalance, currency: record.observedBalanceCurrency }),
  });

export const ledgerEntryToRecord = (entry: WalletLedgerEntry): LedgerEntryRecord => ({
  id: entry.id,
  walletId: entry.walletId,
  transactionId: entry.transactionId,
  direction: entry.direction satisfies LedgerDirection,
  amount: entry.money.amount,
  balanceBefore: entry.balanceBefore.amount,
  balanceAfter: entry.balanceAfter.amount,
  currency: entry.money.currency,
  createdAt: entry.createdAt,
});

export const outboxToRecord = (message: OutboxMessage): OutboxRecord => ({
  id: message.id,
  aggregateId: message.aggregateId,
  eventType: message.eventType,
  payload: { ...message.payload },
  occurredAt: message.occurredAt,
  attempts: message.attempts,
  nextAttemptAt: message.nextAttemptAt ?? null,
  publishedAt: message.publishedAt ?? null,
});

export const inboxToRecord = (message: InboxMessage): InboxRecord => ({
  consumerName: message.consumerName,
  messageId: message.messageId,
  payloadHash: message.payloadHash,
  receivedAt: message.receivedAt,
  processedAt: message.processedAt ?? null,
});
