import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDatabase, type TestDatabase } from './support/test-database.ts';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const LEDGER_APPEND_ONLY = { errno: 'P0001', message: 'wallet_ledger_entries is append-only' };

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('schema_constraints');
});

afterAll(async () => {
  await db.drop();
});

const id = () => Bun.randomUUIDv7();

async function insertWallet(overrides: Record<string, unknown> = {}) {
  const row = { id: id(), player_id: id(), currency: 'BRL', balance: '100.00', version: 1, created_at: NOW, updated_at: NOW, ...overrides };
  await db.sql`INSERT INTO wallets ${db.sql(row)}`;
  return row;
}

async function insertTransaction(walletId: string, overrides: Record<string, unknown> = {}) {
  const external = id();
  const row = {
    id: id(),
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: 'hash',
    wallet_id: walletId,
    player_id: 'player-1',
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    status: 'PROCESSED',
    amount: '10.00',
    currency: 'BRL',
    created_at: NOW,
    ...overrides,
  };
  await db.sql`INSERT INTO wager_transactions ${db.sql(row)}`;
  return row;
}

async function insertLedgerEntry(overrides: Record<string, unknown> = {}) {
  const wallet = await insertWallet();
  const transaction = await insertTransaction(wallet.id);
  const row = {
    id: id(),
    wallet_id: wallet.id,
    transaction_id: transaction.id,
    direction: 'DEBIT',
    amount: '10.00',
    balance_before: '100.00',
    balance_after: '90.00',
    currency: 'BRL',
    created_at: NOW,
    ...overrides,
  };
  await db.sql`INSERT INTO wallet_ledger_entries ${db.sql(row)}`;
  return row;
}

async function insertInboxMessage(overrides: Record<string, unknown> = {}) {
  const row = { consumer_name: 'wager-transactions', message_id: id(), payload_hash: 'hash', received_at: NOW, ...overrides };
  await db.sql`INSERT INTO inbox_messages ${db.sql(row)}`;
  return row;
}

async function insertOutboxMessage(overrides: Record<string, unknown> = {}) {
  const row = { id: id(), aggregate_id: id(), event_type: 'WalletBalanceChanged', payload: { eventId: id() }, occurred_at: NOW, ...overrides };
  await db.sql`INSERT INTO outbox_messages ${db.sql(row)}`;
  return row;
}

const violates = (constraint: string) => expect.objectContaining({ constraint });

// Bun.SQL queries are lazy thenables; expect().rejects only runs a real Promise.
const run = async (query: PromiseLike<unknown>) => query;

describe('wallets table', () => {
  it('rejects a balance update that would go below zero, so no race can overdraw a wallet', async () => {
    const wallet = await insertWallet({ balance: '100.00' });
    const overdraw = db.sql`UPDATE wallets SET balance = balance - ${'100.01'}::numeric WHERE id = ${wallet.id}`;
    await expect(run(overdraw)).rejects.toEqual(violates('ck_wallets_balance_non_negative'));
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const wallet = await insertWallet();
    await expect(insertWallet({ player_id: wallet.player_id })).rejects.toEqual(violates('uq_wallets_player_currency'));
  });

  it('accepts a second wallet for the same player in another currency', async () => {
    const wallet = await insertWallet({ currency: 'BRL' });
    await expect(insertWallet({ player_id: wallet.player_id, currency: 'USD' })).resolves.toBeDefined();
  });

  it('rejects a version below 1, the value a freshly opened wallet starts at', async () => {
    await expect(insertWallet({ version: 0 })).rejects.toEqual(violates('ck_wallets_version_positive'));
  });

  it('rejects a currency that is not three uppercase letters', async () => {
    await expect(insertWallet({ currency: 'brl' })).rejects.toEqual(violates('ck_wallets_currency_format'));
  });
});

describe('wager_transactions table', () => {
  it('rejects a second transaction with the same idempotency key, so a concurrent resend loses on the index', async () => {
    const wallet = await insertWallet();
    const first = await insertTransaction(wallet.id);
    const resend = insertTransaction(wallet.id, { idempotency_key: first.idempotency_key });
    await expect(resend).rejects.toEqual(violates('uq_wager_transactions_idempotency_key'));
  });

  it('rejects the same external transaction id twice for one provider', async () => {
    const wallet = await insertWallet();
    const first = await insertTransaction(wallet.id);
    const duplicate = insertTransaction(wallet.id, { external_transaction_id: first.external_transaction_id });
    await expect(duplicate).rejects.toEqual(violates('uq_wager_transactions_provider_external'));
  });

  it('rejects a refund that names no reference transaction', async () => {
    const wallet = await insertWallet();
    await expect(insertTransaction(wallet.id, { kind: 'REFUND' })).rejects.toEqual(violates('ck_wager_transactions_reversal_has_reference'));
  });

  it('rejects a kind outside the closed list of operations', async () => {
    const wallet = await insertWallet();
    await expect(insertTransaction(wallet.id, { kind: 'BONUS' })).rejects.toEqual(violates('ck_wager_transactions_kind'));
  });

  it('rejects a status outside the transaction lifecycle', async () => {
    const wallet = await insertWallet();
    await expect(insertTransaction(wallet.id, { status: 'DONE' })).rejects.toEqual(violates('ck_wager_transactions_status'));
  });

  it('rejects a negative transaction amount', async () => {
    const wallet = await insertWallet();
    await expect(insertTransaction(wallet.id, { amount: '-1.00' })).rejects.toEqual(violates('ck_wager_transactions_amount_non_negative'));
  });

  it('rejects a currency that is not three uppercase letters', async () => {
    const wallet = await insertWallet();
    await expect(insertTransaction(wallet.id, { currency: 'BR' })).rejects.toEqual(violates('ck_wager_transactions_currency_format'));
  });

  it('rejects a rejected transaction without a failure code, so every refusal tells the provider why', async () => {
    const wallet = await insertWallet();
    await expect(insertTransaction(wallet.id, { status: 'REJECTED' })).rejects.toEqual(violates('ck_wager_transactions_failure_code_matches_status'));
  });

  it('rejects a failure code on a transaction that did not fail', async () => {
    const wallet = await insertWallet();
    const processed = insertTransaction(wallet.id, { status: 'PROCESSED', failure_code: 'INSUFFICIENT_FUNDS' });
    await expect(processed).rejects.toEqual(violates('ck_wager_transactions_failure_code_matches_status'));
  });

  it('rejects a negative count of pending-reference retry attempts', async () => {
    const wallet = await insertWallet();
    const pending = insertTransaction(wallet.id, { kind: 'ROLLBACK', status: 'PENDING_REFERENCE', reference_external_transaction_id: 'missing', retry_attempts: -1 });
    await expect(pending).rejects.toEqual(violates('ck_wager_transactions_retry_attempts_non_negative'));
  });

  describe('reversal of a reference', () => {
    async function processedBetWithRefund() {
      const wallet = await insertWallet();
      const bet = await insertTransaction(wallet.id, { kind: 'BET' });
      const reversalOf = { reference_transaction_id: bet.id, reference_external_transaction_id: bet.external_transaction_id };
      await insertTransaction(wallet.id, { kind: 'REFUND', status: 'PROCESSED', ...reversalOf });
      return { wallet, reversalOf };
    }

    it('rejects a second processed reversal of the same reference, even when the kind differs', async () => {
      const { wallet, reversalOf } = await processedBetWithRefund();
      const rollback = insertTransaction(wallet.id, { kind: 'ROLLBACK', status: 'PROCESSED', ...reversalOf });
      await expect(rollback).rejects.toEqual(violates('uq_one_reversal_per_reference'));
    });

    it('accepts a rejected reversal of an already reversed reference, so the refused attempt stays auditable', async () => {
      const { wallet, reversalOf } = await processedBetWithRefund();
      const refused = insertTransaction(wallet.id, { kind: 'ROLLBACK', status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED', ...reversalOf });
      await expect(refused).resolves.toBeDefined();
    });
  });
});

describe('wallet_ledger_entries table', () => {
  it('rejects an UPDATE of an existing entry, because the ledger is append-only', async () => {
    const entry = await insertLedgerEntry();
    const rewrite = db.sql`UPDATE wallet_ledger_entries SET amount = ${'1.00'}::numeric WHERE id = ${entry.id}`;
    await expect(run(rewrite)).rejects.toMatchObject(LEDGER_APPEND_ONLY);
  });

  it('rejects a DELETE of an existing entry, because the ledger is append-only', async () => {
    const entry = await insertLedgerEntry();
    await expect(run(db.sql`DELETE FROM wallet_ledger_entries WHERE id = ${entry.id}`)).rejects.toMatchObject(LEDGER_APPEND_ONLY);
  });

  it('rejects a TRUNCATE of the ledger, which row triggers do not see', async () => {
    await insertLedgerEntry();
    await expect(run(db.sql`TRUNCATE wallet_ledger_entries`)).rejects.toMatchObject(LEDGER_APPEND_ONLY);
  });

  it('rejects an entry on a wallet other than the one its transaction belongs to', async () => {
    const otherWallet = await insertWallet();
    await expect(insertLedgerEntry({ wallet_id: otherWallet.id })).rejects.toEqual(violates('fk_ledger_transaction_wallet_currency'));
  });

  it('rejects an entry in a currency other than its transaction currency', async () => {
    await expect(insertLedgerEntry({ currency: 'USD' })).rejects.toEqual(violates('fk_ledger_transaction_wallet_currency'));
  });

  it('rejects a currency that is not three uppercase letters', async () => {
    await expect(insertLedgerEntry({ currency: 'brl' })).rejects.toEqual(violates('ck_ledger_currency_format'));
  });

  it('rejects a second entry for the same transaction and wallet, so one operation moves the balance once', async () => {
    const entry = await insertLedgerEntry();
    const again = { ...entry, id: id(), balance_before: '90.00', balance_after: '80.00' };
    await expect(run(db.sql`INSERT INTO wallet_ledger_entries ${db.sql(again)}`)).rejects.toEqual(violates('uq_ledger_transaction_wallet'));
  });

  it('rejects an entry whose balance after does not equal balance before plus or minus the amount', async () => {
    await expect(insertLedgerEntry({ balance_after: '91.00' })).rejects.toEqual(violates('ck_ledger_balanced'));
  });

  it('rejects an entry with a zero amount', async () => {
    await expect(insertLedgerEntry({ amount: '0.00', balance_after: '100.00' })).rejects.toEqual(violates('ck_ledger_amount_positive'));
  });

  it('rejects a debit entry that leaves the balance below zero', async () => {
    const overdraw = insertLedgerEntry({ amount: '10.00', balance_before: '5.00', balance_after: '-5.00' });
    await expect(run(overdraw)).rejects.toEqual(violates('ck_ledger_balance_after_non_negative'));
  });

  it('rejects a credit entry that starts from a negative balance', async () => {
    const credit = insertLedgerEntry({ direction: 'CREDIT', amount: '10.00', balance_before: '-5.00', balance_after: '5.00' });
    await expect(credit).rejects.toEqual(violates('ck_ledger_balance_before_non_negative'));
  });

  // ck_ledger_balanced also needs DEBIT or CREDIT, so it fires first (CHECKs run in name order); ck_ledger_direction is the readable duplicate.
  it('rejects a direction other than debit or credit', async () => {
    await expect(insertLedgerEntry({ direction: 'TRANSFER' })).rejects.toMatchObject({ errno: '23514' });
  });
});

describe('inbox_messages table', () => {
  it('rejects the same message id twice for one consumer, so a redelivery is detected as a duplicate', async () => {
    const message = await insertInboxMessage();
    await expect(insertInboxMessage({ message_id: message.message_id })).rejects.toEqual(violates('pk_inbox_messages'));
  });

  it('accepts the same message id for a different consumer', async () => {
    const message = await insertInboxMessage();
    await expect(insertInboxMessage({ message_id: message.message_id, consumer_name: 'other-consumer' })).resolves.toBeDefined();
  });
});

describe('outbox_messages table', () => {
  it('rejects a negative count of publish attempts', async () => {
    await expect(insertOutboxMessage({ attempts: -1 })).rejects.toEqual(violates('ck_outbox_attempts_non_negative'));
  });
});
