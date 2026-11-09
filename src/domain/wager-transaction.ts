import { Money } from './money.ts';
import type { Wallet } from './wallet.ts';
import { LedgerDirection, oppositeOf, type WalletLedgerEntry } from './wallet-ledger-entry.ts';
import { FailureCode, type RejectionCode } from './failure-codes.ts';
import { wagerPayloadHash } from './payload-hash.ts';
import {
  DomainError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from './errors/domain-errors.ts';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;

/** Valid transitions; an empty list is terminal. PENDING_REFERENCE -> itself is a worker retry that still found nothing. */
export const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [Status.Pending]: [Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed],
  [Status.PendingReference]: [Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed],
  [Status.Processed]: [],
  [Status.Rejected]: [],
  [Status.Failed]: [],
};

const REVERSAL_KINDS: readonly WagerTransactionKind[] = [Kind.Refund, Kind.Rollback];

// WIN/LOSS may point at their BET (rule table: "pode referenciar"); BET and OPENING never reference anything.
const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [Kind.Opening]: [],
  [Kind.Bet]: [],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

/** Business fields of a submission; exactly what the idempotency payload hash covers. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface CreateWagerTransactionProps extends WagerPayload {
  id: string;
  idempotencyKey: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  payloadHash: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Balance seen when the transaction left PENDING; the idempotent replay answers with it. */
  observedBalance?: Money;
  retryAttempts: number;
  /** Undefined means "due now" to the pending-reference worker. */
  nextRetryAt?: Date;
}

/** Plan 4.6: both limits are configuration, whichever is hit first ends the wait. */
export interface PendingReferencePolicy {
  maxAttempts: number;
  ttlMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// 12 attempts with a 5 min cap is ~50 min of active waiting; 24 h is the ceiling for a BET that never shows up.
export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  maxAttempts: 12,
  ttlMs: 24 * 60 * 60 * 1_000,
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60 * 1_000,
};

export interface ApplyContext {
  entryId: string;
  at: Date;
  /** The transaction resolved by (providerId, referenceExternalTransactionId), if it exists. */
  reference?: WagerTransaction;
  /** Whether the reference already has a PROCESSED REFUND or ROLLBACK. */
  referenceAlreadyReversed?: boolean;
}

export const OPENING_PROVIDER_ID = 'internal';
const OPENING_MARKER = 'opening';

export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionState) {}

  /** Born PENDING. Refuses OPENING (internal only) and a reversal without its reference. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new DomainError(FailureCode.KindNotSubmittable, 'OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  /** The internal credit that seeds a wallet; only Wallet.open calls it. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const externalTransactionId = `${OPENING_MARKER}:${props.walletId}`;
    const opening = WagerTransaction.build({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId,
      idempotencyKey: `${OPENING_PROVIDER_ID}:${externalTransactionId}`,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: OPENING_MARKER,
      gameId: OPENING_MARKER,
      kind: Kind.Opening,
      money: props.money,
      createdAt: props.at,
    });
    opening.markProcessed(undefined, props.at, props.money);
    return opening;
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    if (REVERSAL_KINDS.includes(props.kind) && !props.referenceExternalTransactionId) {
      throw new DomainError(FailureCode.InvalidPayload, `${props.kind} requires referenceExternalTransactionId`);
    }
    // A reference that can never resolve is refused here, not parked in PENDING_REFERENCE until the TTL.
    if (props.referenceExternalTransactionId !== undefined) {
      if (ALLOWED_REFERENCE_KINDS[props.kind].length === 0) {
        throw new DomainError(FailureCode.InvalidPayload, `${props.kind} does not accept referenceExternalTransactionId`);
      }
      if (props.referenceExternalTransactionId === props.externalTransactionId) {
        throw new DomainError(FailureCode.InvalidPayload, 'a transaction cannot reference itself');
      }
    }
    if (props.money.isNegative()) throw new InvalidMoneyError('amount must not be negative');
    if (props.kind !== Kind.Loss && props.money.isZero()) throw new InvalidMoneyError(`${props.kind} amount must be positive`);
    return new WagerTransaction({ ...props, payloadHash: wagerPayloadHash(props), status: Status.Pending, retryAttempts: 0 });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id(): string { return this.state.id; }
  get providerId(): string { return this.state.providerId; }
  get externalTransactionId(): string { return this.state.externalTransactionId; }
  get idempotencyKey(): string { return this.state.idempotencyKey; }
  get payloadHash(): string { return this.state.payloadHash; }
  get walletId(): string { return this.state.walletId; }
  get playerId(): string { return this.state.playerId; }
  get roundId(): string { return this.state.roundId; }
  get gameId(): string { return this.state.gameId; }
  get kind(): WagerTransactionKind { return this.state.kind; }
  get money(): Money { return this.state.money; }
  get referenceExternalTransactionId(): string | undefined { return this.state.referenceExternalTransactionId; }
  get createdAt(): Date { return this.state.createdAt; }
  get status(): WagerTransactionStatus { return this.state.status; }
  get referenceTransactionId(): string | undefined { return this.state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  get processedAt(): Date | undefined { return this.state.processedAt; }
  get observedBalance(): Money | undefined { return this.state.observedBalance; }
  get retryAttempts(): number { return this.state.retryAttempts; }
  get nextRetryAt(): Date | undefined { return this.state.nextRetryAt; }

  /** Snapshot for persistence mappers. */
  toState(): WagerTransactionState {
    return { ...this.state };
  }

  /** Runs the rules against the (locked) wallet; ends PROCESSED, REJECTED or PENDING_REFERENCE; returns the entry if money moved. */
  applyTo(wallet: Wallet, ctx: ApplyContext): WalletLedgerEntry | undefined {
    if (this.isTerminal()) throw new InvalidTransactionStateError(`transaction ${this.id} is ${this.status} (terminal)`);
    if (wallet.id !== this.walletId) throw new InvariantViolationError(`transaction ${this.id} targets another wallet`);
    if (this.money.currency !== wallet.currency) return this.rejectWith(FailureCode.CurrencyMismatch, wallet);
    if (this.playerId !== wallet.playerId) return this.rejectWith(FailureCode.WalletPlayerMismatch, wallet);

    const { reference } = ctx;
    if (reference && reference.externalTransactionId !== this.referenceExternalTransactionId) {
      throw new InvariantViolationError(`reference ${reference.externalTransactionId} is not the one ${this.id} names`);
    }
    if (this.referenceExternalTransactionId !== undefined) {
      // A PENDING or PENDING_REFERENCE reference is not a fact yet: wait as if it were missing.
      if (!reference || !reference.isTerminal()) {
        this.markPendingReference(wallet.balance);
        return undefined;
      }
      const violation = this.referenceViolation(reference, ctx.referenceAlreadyReversed ?? false);
      if (violation) return this.rejectWith(violation, wallet);
    }

    if (!this.affectsBalance()) {
      this.markProcessed(reference?.id, ctx.at, wallet.balance);
      return undefined;
    }

    const movement = { entryId: ctx.entryId, transactionId: this.id, at: ctx.at };
    let entry: WalletLedgerEntry;
    try {
      entry =
        this.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(this.money, movement)
          : wallet.credit(this.money, movement);
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      // Rule 9: an overdrawing reversal is operationally different from a bet without funds.
      return this.rejectWith(this.requiresReference() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds, wallet);
    }
    this.markProcessed(reference?.id, ctx.at, wallet.balance);
    return entry;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.transitionTo(Status.Processed);
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.processedAt = at;
    this.state.observedBalance = observedBalance;
  }

  markPendingReference(observedBalance: Money): void {
    this.transitionTo(Status.PendingReference);
    this.state.observedBalance = observedBalance;
  }

  reject(code: RejectionCode, observedBalance: Money): void {
    this.transitionTo(Status.Rejected);
    this.state.failureCode = code;
    this.state.observedBalance = observedBalance;
  }

  /** The worker found the reference still missing: wait 2^attempts x base, capped. */
  scheduleRetry(now: Date, policy: PendingReferencePolicy): void {
    if (this.status !== Status.PendingReference) {
      throw new InvalidTransactionStateError(`transaction ${this.id} is ${this.status}, only PENDING_REFERENCE retries`);
    }
    this.state.retryAttempts += 1;
    const delay = Math.min(2 ** this.state.retryAttempts * policy.baseDelayMs, policy.maxDelayMs);
    this.state.nextRetryAt = new Date(now.getTime() + delay);
  }

  hasExhaustedRetries(now: Date, policy: PendingReferencePolicy): boolean {
    return this.state.retryAttempts >= policy.maxAttempts || now.getTime() - this.createdAt.getTime() >= policy.ttlMs;
  }

  fail(code: FailureCode.PermanentFailure): void {
    this.transitionTo(Status.Failed);
    this.state.failureCode = code;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this.status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  /** True for REFUND and ROLLBACK, which are also exactly the reversals. */
  requiresReference(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Rollback:
        if (!reference) throw new InvariantViolationError('ROLLBACK direction depends on its reference');
        return oppositeOf(reference.ledgerDirectionFor());
      case Kind.Loss:
        throw new InvariantViolationError('LOSS does not move money');
    }
  }

  private referenceViolation(reference: WagerTransaction, alreadyReversed: boolean): RejectionCode | undefined {
    if (!ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind)) return FailureCode.ReferenceKindNotAllowed;
    const sameScope =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameScope) return FailureCode.ReferenceScopeMismatch;
    if (reference.status !== Status.Processed) return FailureCode.ReferenceNotProcessed;
    if (!this.requiresReference()) return undefined;
    if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    if (!reference.money.equals(this.money)) return FailureCode.AmountMismatch;
    return undefined;
  }

  private rejectWith(code: RejectionCode, wallet: Wallet): undefined {
    this.reject(code, wallet.balance);
    return undefined;
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this.status].includes(next)) {
      throw new InvalidTransactionStateError(`transaction ${this.id} cannot go from ${this.status} to ${next}`);
    }
    this.state.status = next;
  }
}
