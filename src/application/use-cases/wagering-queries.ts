import type { Wallet } from '../../domain/wallet.ts';
import type { WagerTransaction } from '../../domain/wager-transaction.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { DomainError } from '../../domain/errors/domain-errors.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';

export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async wallet(id: string): Promise<Wallet> {
    const wallet = await this.uow.read((r) => r.wallets.findById(id));
    if (!wallet) throw new DomainError(FailureCode.WalletNotFound, `wallet ${id} not found`);
    return wallet;
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
