import type { Wallet } from '../../domain/wallet.ts';
import type { WagerTransaction } from '../../domain/wager-transaction.ts';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import type { InboxMessage } from '../../domain/inbox-message.ts';
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

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  enqueue(events: readonly IntegrationEvent<unknown>[]): Promise<void>;
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
