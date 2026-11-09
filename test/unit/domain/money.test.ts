import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money.ts';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors/domain-errors.ts';
import { FailureCode } from '../../../src/domain/failure-codes.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('input contract', () => {
    it('accepts a decimal string with exactly two decimals and serializes it back unchanged', () => {
      expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(brl('0.01').amount).toBe('0.01');
      expect(brl('99999999999999999.99').amount).toBe('99999999999999999.99');
    });

    it.each([
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['scientific notation', '1e3'],
      ['an empty string', ''],
      ['three decimals instead of rounding', '1.005'],
      ['fewer than two decimals', '25.5'],
      ['no decimals', '25'],
      ['a negative value', '-1.00'],
      ['an explicit plus sign', '+1.00'],
      ['leading zeros', '01.00'],
      ['surrounding whitespace', ' 1.00'],
      ['more integer digits than NUMERIC(19,2) holds', '100000000000000000.00'],
    ])('rejects %s with INVALID_MONEY', (_label, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejects an amount sent as a JSON number, so money never travels as a float', () => {
      expect(() => Money.from({ amount: 10.25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it.each(['brl', 'BR', 'BRLX', ''])('rejects the currency %p because it is not an ISO-4217 code', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });

    it('carries the INVALID_MONEY failure code so the API can answer 400', () => {
      try {
        brl('1.5');
        throw new Error('expected a throw');
      } catch (error) {
        expect((error as InvalidMoneyError).code).toBe(FailureCode.InvalidMoney);
      }
    });
  });

  describe('arithmetic', () => {
    it('adds 0.10 and 0.20 to exactly 0.30, where binary floats give 0.30000000000000004', () => {
      expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    });

    it('keeps cents exact at the top of the NUMERIC(19,2) range', () => {
      expect(brl('99999999999999999.98').add(brl('0.01')).amount).toBe('99999999999999999.99');
    });

    it('refuses a result wider than NUMERIC(19,2) instead of letting the insert fail later', () => {
      expect(() => brl('99999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
    });

    it('subtracts into a negative value that still serializes with two decimals', () => {
      const diff = brl('5.00').subtract(brl('7.50'));
      expect(diff.amount).toBe('-2.50');
      expect(diff.isNegative()).toBe(true);
    });

    it('returns a new instance on every operation and leaves the operands untouched', () => {
      const a = brl('10.00');
      const b = brl('3.00');
      const sum = a.add(b);
      expect(sum).not.toBe(a);
      expect(a.amount).toBe('10.00');
      expect(b.amount).toBe('3.00');
    });

    it('treats a negated zero as zero, neither negative nor positive', () => {
      const negZero = Money.zero('BRL').negate();
      expect(negZero.isZero()).toBe(true);
      expect(negZero.isNegative()).toBe(false);
      expect(negZero.isPositive()).toBe(false);
      expect(negZero.amount).toBe('0.00');
    });
  });

  describe('currency conflicts', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('throws CurrencyMismatchError on %s across currencies', (_op, run) => {
      expect(run).toThrow(CurrencyMismatchError);
    });

    it('reports two equal amounts in different currencies as not equal', () => {
      expect(brl('1.00').equals(usd)).toBe(false);
      expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    });
  });

  it('orders amounts of the same currency', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
  });

  it('prints amount and currency for logs and messages', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });
});
