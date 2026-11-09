import { AsyncLocalStorage } from 'node:async_hooks';

/** Identifiers only: whatever lands here is printed on every log line of the request or message. */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  kind?: string;
  status?: string;
  failureCode?: string;
  idempotentReplay?: boolean;
}

const storage = new AsyncLocalStorage<LogFields>();

/** The store is mutable on purpose: the entry point keeps the reference and logs what the layers below assigned. */
export const logContext = {
  run<T>(fields: LogFields, work: () => T): T {
    return storage.run(fields, work);
  },
  assign(fields: LogFields): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
  current(): LogFields | undefined {
    return storage.getStore();
  },
};
