import { Clock } from '../application/ports/clock.ts';
import { IdGenerator } from '../application/ports/id-generator.ts';

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** Time-ordered UUIDs keep primary-key inserts at the right edge of the btree. */
export class UuidV7IdGenerator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
