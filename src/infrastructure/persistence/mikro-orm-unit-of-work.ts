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
import { DuplicateInboxMessageError, DuplicateTransactionError, LockConflictError, TransientFailureError } from '../../application/errors.ts';
import type { LockConflictReason } from '../../application/ports/metrics.ts';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  WagerTransactionSchema,
  WalletSchema,
  inboxToRecord,
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  outboxToDomain,
  outboxToRecord,
  transactionOutcome,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
  type LedgerEntryRecord,
  type OutboxRecord,
  type WagerTransactionRecord,
  type WalletRecord,
} from './schemas.ts';
import { Money } from '../../domain/money.ts';

// Plan 4.1: a request that waits longer than this for a wallet gets a 503 and retries instead of piling up.
const LOCK_TIMEOUT = '3s';

// Not FOR UPDATE: it conflicts with the FOR KEY SHARE the transaction insert's FK check holds here, so two bets would deadlock.
const LOCK_WALLET_SQL = 'select * from wallets where id = ? for no key update';

const LEDGER_PAGE_SQL = 'select * from wallet_ledger_entries where wallet_id = ? order by seq desc limit ?';
const LEDGER_PAGE_BEFORE_SQL = 'select * from wallet_ledger_entries where wallet_id = ? and seq < ? order by seq desc limit ?';

// One statement is one snapshot under READ COMMITTED; reading the wallet and the ledger separately lets a bet commit in between.
const LEDGER_TOTALS_SQL = `
  select w.balance::text as balance, w.currency,
    round(coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0), 2)::text as credits,
    round(coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0), 2)::text as debits,
    count(l.id) as entries
  from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
  where w.id = ?
  group by w.id`;


// SKIP LOCKED skips rows other publishers hold; NOT EXISTS orders an aggregate by (occurred_at, id): siblings share occurred_at, UUIDv7 ids rise in emission order.
const CLAIM_DUE_OUTBOX_SQL = `select * from outbox_messages o
  where o.published_at is null and (o.next_attempt_at is null or o.next_attempt_at <= ?)
    and not exists (select 1 from outbox_messages earlier
      where earlier.aggregate_id = o.aggregate_id and earlier.published_at is null
        and (earlier.occurred_at, earlier.id) < (o.occurred_at, o.id))
  order by o.occurred_at, o.id limit ? for update skip locked`;

const REVERSAL_KINDS =[WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

// One row per claim: each pending transaction gets its own SQL transaction, so a poison row never holds up the batch.
// NULL next_retry_at is "never tried" and goes first. SKIP LOCKED is what lets N workers share the queue without waiting.
const CLAIM_PENDING_REFERENCE_SQL = `select * from wager_transactions
  where status = '${WagerTransactionStatus.PendingReference}' and (next_retry_at is null or next_retry_at <= ?)
  order by next_retry_at nulls first, created_at limit 1 for no key update skip locked`;
const LOCK_PENDING_REFERENCE_SQL = `select * from wager_transactions
  where id = ? and status = '${WagerTransactionStatus.PendingReference}' for no key update skip locked`;

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
        if (updated !== 1) throw new LockConflictError('version_conflict', `wallet ${wallet.id} changed concurrently`);
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
      async claimDuePendingReference(now) {
        const [row] = await em.execute<WagerTransactionRecord[]>(CLAIM_PENDING_REFERENCE_SQL, [now]);
        return row ? transactionToDomain(em.map(WagerTransactionSchema, row)) : undefined;
      },
      async lockPendingReferenceById(id) {
        const [row] = await em.execute<WagerTransactionRecord[]>(LOCK_PENDING_REFERENCE_SQL, [id]);
        return row ? transactionToDomain(em.map(WagerTransactionSchema, row)) : undefined;
      },
    },
    ledger: {
      async append(entry) {
        await em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
      },
      async pageNewestFirst(walletId, beforeSeq, limit) {
        type Row = LedgerEntryRecord & { seq: string };
        const rows =
          beforeSeq === undefined
            ? await em.execute<Row[]>(LEDGER_PAGE_SQL, [walletId, limit])
            : await em.execute<Row[]>(LEDGER_PAGE_BEFORE_SQL, [walletId, beforeSeq, limit]);
        return rows.map((row) => ({ entry: ledgerEntryToDomain(em.map(LedgerEntrySchema, row)), seq: String(row.seq) }));
      },
      async totals(walletId) {
        const [row] = await em.execute<{ balance: string; currency: string; credits: string; debits: string; entries: string }[]>(
          LEDGER_TOTALS_SQL,
          [walletId],
        );
        if (!row) return undefined;
        const money = (amount: string) => Money.from({ amount, currency: row.currency });
        return { storedBalance: money(row.balance), credits: money(row.credits), debits: money(row.debits), entries: Number(row.entries) };
      },
    },
    outbox: {
      async enqueue(events) {
        if (events.length === 0) return;
        await em.insertMany(OutboxSchema, events.map((event) => outboxToRecord(OutboxMessage.enqueue(event))));
      },
      async claimDue(now, limit) {
        const rows = await em.execute<OutboxRecord[]>(CLAIM_DUE_OUTBOX_SQL, [now, limit]);
        return rows.map((row) => outboxToDomain(em.map(OutboxSchema, row)));
      },
      async save(message) {
        await em.nativeUpdate(
          OutboxSchema,
          { id: message.id },
          { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt ?? null, publishedAt: message.publishedAt ?? null },
        );
      },
    },
    inbox: {
      async add(message) {
        await em.insert(InboxSchema, inboxToRecord(message));
      },
    },
  };
}

const LOCK_CONFLICT_BY_SQLSTATE: Record<string, LockConflictReason> = {
  '55P03': 'lock_timeout',
  '40001': 'serialization',
  '40P01': 'deadlock',
};
// admin/crash shutdown, too many connections; plus the whole connection class 08.
const TRANSIENT_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);
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
  const lockConflict = code ? LOCK_CONFLICT_BY_SQLSTATE[code] : undefined;
  if (lockConflict) return new LockConflictError(lockConflict, `wallet contended (${code})`, { cause: error });
  if (code && (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NETWORK_CODES.has(code))) {
    return new TransientFailureError(`database unavailable or contended (${code})`, { cause: error });
  }
  if (error instanceof DriverException && /timeout exceeded when trying to connect|Connection terminated/i.test(error.message)) {
    return new TransientFailureError('database connection unavailable', { cause: error });
  }
  return error;
}
