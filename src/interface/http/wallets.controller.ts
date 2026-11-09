import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import type { MoneyProps } from '../../domain/money.ts';
import type { Wallet } from '../../domain/wallet.ts';
import { CreateWallet } from '../../application/use-cases/create-wallet.ts';
import { WageringQueries } from '../../application/use-cases/wagering-queries.ts';
import { parseCreateWallet, parseUuid } from '../../application/input.ts';
import { CORRELATION_HEADER, correlationIdFrom } from './http-contract.ts';

interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const walletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers(CORRELATION_HEADER) correlationId?: string): Promise<WalletView> {
    const input = parseCreateWallet(body);
    return walletView(await this.createWallet.execute({ ...input, correlationId: correlationIdFrom(correlationId) }));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return walletView(await this.queries.wallet(parseUuid(walletId, 'walletId')));
  }
}
