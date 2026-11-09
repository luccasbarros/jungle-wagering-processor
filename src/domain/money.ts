import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors/domain-errors.ts';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
// 17 integer digits + 2 decimals is the NUMERIC(19,2) column; anything wider would fail on insert, so it fails here.
const MAX_INTEGER_DIGITS = 17;
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${SCALE}}$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// Private clone: precision far above what two NUMERIC(19,2) values need, so add/subtract never round.
const Exact = Decimal.clone({ precision: 40 });
const LIMIT = new Exact(10).pow(MAX_INTEGER_DIGITS);

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Input contract: non-negative decimal string with exactly 2 decimals and an ISO-4217 code. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props ?? ({} as MoneyProps);
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`amount must be a decimal string with ${SCALE} decimals, got ${String(amount)}`);
    }
    return new Money(new Exact(amount), Money.validCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new Exact(0), Money.validCurrency(currency));
  }

  private static validCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency must be an ISO-4217 code, got ${String(currency)}`);
    }
    return currency;
  }

  private static ofResult(value: Decimal, currency: string): Money {
    if (value.abs().gte(LIMIT)) throw new InvalidMoneyError('amount exceeds NUMERIC(19,2)');
    return new Money(value, currency);
  }

  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofResult(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofResult(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.neg(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  // lt/gt instead of isNeg/isPos: decimal.js reports -0 as negative.
  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  /** Different currencies are simply not equal; ordering across currencies is what throws. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
