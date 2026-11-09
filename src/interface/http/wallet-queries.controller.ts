import { Controller, Get, HttpCode, Logger, Param, Post, Query } from '@nestjs/common';
import type { MoneyProps } from '../../domain/money.ts';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import { WageringQueries } from '../../application/use-cases/wagering-queries.ts';
import { ReconcileWallet } from '../../application/use-cases/reconcile-wallet.ts';
import { parseLedgerPage, parseUuid } from '../../application/input.ts';

const ledgerEntryView = (entry: WalletLedgerEntry) => ({
  id: entry.id,
  transactionId: entry.transactionId,
  direction: entry.direction,
  money: entry.money.toJSON(),
  balanceBefore: entry.balanceBefore.toJSON(),
  balanceAfter: entry.balanceAfter.toJSON(),
  createdAt: entry.createdAt.toISOString(),
});

interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Controller('wallets/:walletId')
export class WalletQueriesController {
  private readonly logger = new Logger(WalletQueriesController.name);

  constructor(
    private readonly queries: WageringQueries,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Get('ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown) {
    const page = await this.queries.ledger(parseUuid(walletId, 'walletId'), parseLedgerPage(cursor, limit));
    return { entries: page.entries.map(ledgerEntryView), nextCursor: page.nextCursor ?? null };
  }

  // 200, not 201: reconciliation reads and reports, it creates nothing.
  @Post('reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    const result = await this.reconcileWallet.execute(parseUuid(walletId, 'walletId'));
    // No amounts in the line (spec 12): correlationId and walletId come from the log context, the figures from the response.
    if (!result.consistent) this.logger.warn(`reconciliation divergence: stored balance differs from the sum of ${result.checkedEntries} ledger entries`);
    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}
