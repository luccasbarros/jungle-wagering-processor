import type { Money } from '../../domain/money.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { DomainError } from '../../domain/errors/domain-errors.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { Metrics } from '../ports/metrics.ts';
import { logContext } from '../log-context.ts';

export interface Reconciliation {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** stored minus calculated: positive means the wallet holds more than its ledger explains. */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/** Read-only by design: a divergence is reported and counted, never corrected, so the evidence survives for whoever investigates. */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string): Promise<Reconciliation> {
    logContext.assign({ walletId });
    const totals = await this.uow.read((r) => r.ledger.totals(walletId));
    if (!totals) throw new DomainError(FailureCode.WalletNotFound, `wallet ${walletId} not found`);

    const calculatedBalance = totals.credits.subtract(totals.debits);
    const difference = totals.storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) this.metrics.reconciliationDiverged();
    return { walletId, storedBalance: totals.storedBalance, calculatedBalance, difference, consistent, checkedEntries: totals.entries };
  }
}
