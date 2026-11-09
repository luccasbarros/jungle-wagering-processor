import type { Wallet } from '../../domain/wallet.ts';
import type { WagerTransaction } from '../../domain/wager-transaction.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { DomainError } from '../../domain/errors/domain-errors.ts';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import { encodeLedgerCursor, type LedgerPageQuery } from '../input.ts';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async wallet(id: string): Promise<Wallet> {
    const wallet = await this.uow.read((r) => r.wallets.findById(id));
    if (!wallet) throw new DomainError(FailureCode.WalletNotFound, `wallet ${id} not found`);
    return wallet;
  }

  async ledger(walletId: string, page: LedgerPageQuery): Promise<LedgerPage> {
    await this.wallet(walletId);
    // One row past the page tells whether an older page exists without a count query.
    const rows = await this.uow.read((r) => r.ledger.pageNewestFirst(walletId, page.beforeSeq, page.limit + 1));
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return {
      entries: shown.map((row) => row.entry),
      nextCursor: rows.length > page.limit && last ? encodeLedgerCursor(last.seq) : undefined,
    };
  }

  async transaction(id: string): Promise<WagerTransaction> {
    return found(await this.uow.read((r) => r.transactions.findById(id)));
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return found(await this.uow.read((r) => r.transactions.findByExternalId(providerId, externalTransactionId)));
  }
}

function found(transaction: WagerTransaction | undefined): WagerTransaction {
  if (!transaction) throw new DomainError(FailureCode.TransactionNotFound, 'wager transaction not found');
  return transaction;
}
