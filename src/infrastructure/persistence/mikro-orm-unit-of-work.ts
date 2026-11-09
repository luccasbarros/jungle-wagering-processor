import {
  DriverException,
  ForeignKeyConstraintViolationException,
  UniqueConstraintViolationException,
  type EntityManager,
  type MikroORM,
} from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/outbox-message.ts';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { DomainError } from '../../domain/errors/domain-errors.ts';
import { UnitOfWork, type Repositories } from '../../application/ports/unit-of-work.ts';
import { DuplicateInboxMessageError, DuplicateTransactionError, TransientFailureError } from '../../application/errors.ts';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  WagerTransactionSchema,
  WalletSchema,
  inboxToRecord,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionOutcome,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
  type WalletRecord,
} from './schemas.ts';

// Plan 4.1: a request that waits longer than this for a wallet gets a 503 and retries instead of piling up.
const LOCK_TIMEOUT = '3s';

// Not FOR UPDATE: it conflicts with the FOR KEY SHARE the transaction insert's FK check holds here, so two bets would deadlock.
const LOCK_WALLET_SQL = 'select * from wallets where id = ? for no key update';

const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return translated(() =>
      this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
        return work(repositoriesFor(em));
      }),
    );
  }

  read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return translated(() => work(repositoriesFor(this.orm.em.fork())));
  }
}

// Statements run when awaited, never at a deferred flush: their order is the concurrency argument and a flush may reorder.
function repositoriesFor(em: EntityManager): Repositories {
  return {
    wallets: {
      async insert(wallet) {
        await em.insert(WalletSchema, walletToRecord(wallet));
      },
      async findById(id) {
        const record = await em.findOne(WalletSchema, { id });
        return record ? walletToDomain(record) : undefined;
      },
      async lockById(id) {
        const [row] = await em.execute<WalletRecord[]>(LOCK_WALLET_SQL, [id]);
        return row ? walletToDomain(em.map(WalletSchema, row)) : undefined;
      },
      async save(wallet, expectedVersion) {
        const updated = await em.nativeUpdate(
          WalletSchema,
          { id: wallet.id, version: expectedVersion },
          { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
        );
        if (updated !== 1) throw new TransientFailureError(`wallet ${wallet.id} changed concurrently`);
      },
    },
    transactions: {
      async insert(transaction) {
        await em.insert(WagerTransactionSchema, transactionToRecord(transaction));
      },
      async save(transaction) {
        await em.nativeUpdate(WagerTransactionSchema, { id: transaction.id }, transactionOutcome(transaction));
      },
      async findById(id) {
        const record = await em.findOne(WagerTransactionSchema, { id });
        return record ? transactionToDomain(record) : undefined;
      },
      async findByIdempotencyKey(idempotencyKey) {
        const record = await em.findOne(WagerTransactionSchema, { idempotencyKey });
        return record ? transactionToDomain(record) : undefined;
      },
      async findByExternalId(providerId, externalTransactionId) {
        const record = await em.findOne(WagerTransactionSchema, { providerId, externalTransactionId });
        return record ? transactionToDomain(record) : undefined;
      },
      async hasProcessedReversal(referenceTransactionId) {
        const reversals = await em.count(WagerTransactionSchema, {
          referenceTransactionId,
          status: WagerTransactionStatus.Processed,
          kind: { $in: REVERSAL_KINDS },
        });
        return reversals > 0;
      },
    },
    ledger: {
      async append(entry) {
        await em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
      },
    },
    outbox: {
      async enqueue(events) {
        if (events.length === 0) return;
        await em.insertMany(OutboxSchema, events.map((event) => outboxToRecord(OutboxMessage.enqueue(event))));
      },
    },
    inbox: {
      async add(message) {
        await em.insert(InboxSchema, inboxToRecord(message));
      },
    },
  };
}

// lock_not_available, serialization/deadlock, admin/crash shutdown, too many connections; plus the whole connection class 08.
const TRANSIENT_SQLSTATES = new Set(['55P03', '40001', '40P01', '57P01', '57P02', '57P03', '53300']);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translate(error);
  }
}

function translate(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  if (error instanceof UniqueConstraintViolationException) {
    if (constraint === 'uq_wager_transactions_idempotency_key') return new DuplicateTransactionError('idempotencyKey');
    if (constraint === 'uq_wager_transactions_provider_external') return new DuplicateTransactionError('externalTransactionId');
    if (constraint === 'pk_inbox_messages') return new DuplicateInboxMessageError();
    if (constraint === 'uq_wallets_player_currency') {
      return new DomainError(FailureCode.WalletAlreadyExists, 'the player already has a wallet in this currency');
    }
  }
  if (error instanceof ForeignKeyConstraintViolationException && constraint === 'fk_wager_transactions_wallet') {
    return new DomainError(FailureCode.WalletNotFound, 'wallet not found');
  }
  if (code && (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NETWORK_CODES.has(code))) {
    return new TransientFailureError(`database unavailable or contended (${code})`, { cause: error });
  }
  if (error instanceof DriverException && /timeout exceeded when trying to connect|Connection terminated/i.test(error.message)) {
    return new TransientFailureError('database connection unavailable', { cause: error });
  }
  return error;
}
