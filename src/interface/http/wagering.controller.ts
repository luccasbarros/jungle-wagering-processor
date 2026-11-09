import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { MoneyProps } from '../../domain/money.ts';
import type { WagerTransaction } from '../../domain/wager-transaction.ts';
import { SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction.ts';
import { WageringQueries } from '../../application/use-cases/wagering-queries.ts';
import { parseIdempotencyKey, parseUuid, parseWagerPayload } from '../../application/input.ts';
import { CORRELATION_HEADER, HTTP_STATUS_BY_TRANSACTION_STATUS, correlationIdFrom } from './http-contract.ts';

interface SubmissionView {
  transactionId: string;
  status: string;
  failureCode?: string;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

const transactionView = (tx: WagerTransaction) => ({
  id: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  referenceExternalTransactionId: tx.referenceExternalTransactionId,
  referenceTransactionId: tx.referenceTransactionId,
  status: tx.status,
  failureCode: tx.failureCode,
  balance: tx.observedBalance?.toJSON(),
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString(),
});

@Controller()
export class WageringController {
  constructor(
    private readonly submitWager: SubmitWagerTransaction,
    private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers(CORRELATION_HEADER) correlationId: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<SubmissionView> {
    const command = {
      idempotencyKey: parseIdempotencyKey(idempotencyKey),
      payload: parseWagerPayload(body),
      correlationId: correlationIdFrom(correlationId),
    };
    const { transaction, idempotentReplay } = await this.submitWager.execute(command);
    response.status(HTTP_STATUS_BY_TRANSACTION_STATUS[transaction.status] ?? 500);
    return {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      balance: transaction.observedBalance?.toJSON(),
      idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    return transactionView(await this.queries.transaction(parseUuid(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return transactionView(await this.queries.transactionByExternalId(providerId, externalTransactionId));
  }
}
