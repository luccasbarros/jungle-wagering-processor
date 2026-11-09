import { Wallet } from '../../domain/wallet.ts';
import type { Money } from '../../domain/money.ts';
import type { Clock } from '../ports/clock.ts';
import type { IdGenerator } from '../ports/id-generator.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import { eventsFor } from './submit-wager-transaction.ts';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** The wallet, its OPENING transaction, the opening credit and their events commit together. */
  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const at = this.clock.now();
    const { wallet, opening } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      at,
      openingTransactionId: this.ids.next(),
      openingEntryId: this.ids.next(),
    });

    await this.uow.transaction(async (r) => {
      await r.wallets.insert(wallet);
      if (!opening) return;
      await r.transactions.insert(opening.transaction);
      await r.ledger.append(opening.entry);
      const context = () => ({ eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at });
      await r.outbox.enqueue(eventsFor(opening.transaction, wallet, opening.entry, context));
    });
    return wallet;
  }
}
