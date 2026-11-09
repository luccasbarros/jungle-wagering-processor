import { Migration } from '@mikro-orm/migrations';

export class Migration20261109000000InitialSchema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID CONSTRAINT pk_wallets PRIMARY KEY,
        player_id TEXT NOT NULL,
        currency CHAR(3) NOT NULL CONSTRAINT ck_wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        balance NUMERIC(19,2) NOT NULL CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        version INTEGER NOT NULL CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID CONSTRAINT pk_wager_transactions PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL CONSTRAINT uq_wager_transactions_idempotency_key UNIQUE,
        payload_hash TEXT NOT NULL,
        wallet_id UUID NOT NULL CONSTRAINT fk_wager_transactions_wallet REFERENCES wallets (id),
        player_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        kind TEXT NOT NULL CONSTRAINT ck_wager_transactions_kind
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        status TEXT NOT NULL CONSTRAINT ck_wager_transactions_status
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        amount NUMERIC(19,2) NOT NULL CONSTRAINT ck_wager_transactions_amount_non_negative CHECK (amount >= 0),
        currency CHAR(3) NOT NULL CONSTRAINT ck_wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id TEXT,
        reference_transaction_id UUID CONSTRAINT fk_wager_transactions_reference REFERENCES wager_transactions (id),
        failure_code TEXT,
        observed_balance NUMERIC(19,2),
        retry_attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_wager_transactions_retry_attempts_non_negative CHECK (retry_attempts >= 0),
        next_retry_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        CONSTRAINT uq_wager_transactions_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_transactions_id_wallet_currency UNIQUE (id, wallet_id, currency),
        CONSTRAINT ck_wager_transactions_reversal_has_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_transactions_failure_code_matches_status
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL))
      )`);

    // Any kind counts: a REFUND plus a ROLLBACK of the same BET would credit it twice.
    this.addSql(`
      CREATE UNIQUE INDEX uq_one_reversal_per_reference ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`);

    this.addSql(`
      CREATE INDEX ix_pending_reference ON wager_transactions (next_retry_at)
        WHERE status = 'PENDING_REFERENCE'`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID CONSTRAINT pk_wallet_ledger_entries PRIMARY KEY,
        seq BIGSERIAL NOT NULL CONSTRAINT uq_ledger_seq UNIQUE,
        wallet_id UUID NOT NULL CONSTRAINT fk_ledger_wallet REFERENCES wallets (id),
        transaction_id UUID NOT NULL,
        direction TEXT NOT NULL CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount NUMERIC(19,2) NOT NULL CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
        balance_before NUMERIC(19,2) NOT NULL CONSTRAINT ck_ledger_balance_before_non_negative CHECK (balance_before >= 0),
        balance_after NUMERIC(19,2) NOT NULL CONSTRAINT ck_ledger_balance_after_non_negative CHECK (balance_after >= 0),
        currency CHAR(3) NOT NULL CONSTRAINT ck_ledger_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT fk_ledger_transaction_wallet_currency FOREIGN KEY (transaction_id, wallet_id, currency)
          REFERENCES wager_transactions (id, wallet_id, currency),
        CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ck_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )`);

    this.addSql(`
      CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only';
      END
      $$`);

    this.addSql(`
      CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable()`);

    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable()`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID CONSTRAINT pk_outbox_messages PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_outbox_attempts_non_negative CHECK (attempts >= 0),
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      )`);

    this.addSql(`
      CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at, occurred_at)
        WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
    this.addSql('DROP TABLE wallet_ledger_entries');
    this.addSql('DROP FUNCTION ledger_immutable()');
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP TABLE wallets');
  }
}
