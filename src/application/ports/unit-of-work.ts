import type { Money } from '../../domain/money.ts';
import type { Wallet } from '../../domain/wallet.ts';
import type { WagerTransaction } from '../../domain/wager-transaction.ts';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import type { InboxMessage } from '../../domain/inbox-message.ts';
import type { OutboxMessage } from '../../domain/outbox-message.ts';
import type { IntegrationEvent } from '../../domain/events/integration-event.ts';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** Exclusive row lock held until the surrounding SQL transaction ends. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Writes balance, version and updatedAt only if the stored version is still `expectedVersion`. */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  save(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Locks and returns one due PENDING_REFERENCE row nobody else holds (SKIP LOCKED); undefined when none is due. */
  claimDuePendingReference(now: Date): Promise<WagerTransaction | undefined>;
  /** Locks the row if it is still PENDING_REFERENCE and free; undefined otherwise. */
  lockPendingReferenceById(id: string): Promise<WagerTransaction | undefined>;
}

/** `seq` is the entry's position in commit order within its wallet: every ledger write holds the wallet lock. */
export interface LedgerPosition {
  entry: WalletLedgerEntry;
  seq: string;
}

export interface LedgerTotals {
  storedBalance: Money;
  credits: Money;
  debits: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first; with `beforeSeq`, only entries older than that position. */
  pageNewestFirst(walletId: string, beforeSeq: string | undefined, limit: number): Promise<LedgerPosition[]>;
  /** Stored balance and ledger sums from one snapshot, so a write committing in between cannot read as a divergence. */
  totals(walletId: string): Promise<LedgerTotals | undefined>;
}

export interface OutboxRepository {
  enqueue(events: readonly IntegrationEvent<unknown>[]): Promise<void>;
  /** Locks and returns up to `limit` due messages, skipping rows another transaction already holds. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Writes attempts, nextAttemptAt and publishedAt. */
  save(message: OutboxMessage): Promise<void>;
}

export interface InboxRepository {
  add(message: InboxMessage): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/** Every repository handed to `transaction` shares one SQL transaction: it all commits or nothing does. */
export abstract class UnitOfWork {
  abstract transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  abstract read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
