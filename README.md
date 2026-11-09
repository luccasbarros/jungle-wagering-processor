# Distributed Wagering Processor

[![ci](https://github.com/luccasbarros/jungle-wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/luccasbarros/jungle-wagering-processor/actions/workflows/ci.yml)

A financial service that applies wagering operations (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) from game providers to player wallets. Operations arrive over HTTP or an SQS FIFO queue, both feeding the same use case; each one runs in a single PostgreSQL transaction that locks the wallet row, enforces idempotency, moves the balance, appends an immutable ledger entry, records the inbox row (queue path) and stores the integration events in a transactional outbox. The service stays correct under duplicated, out-of-order and concurrent deliveries across three or more instances, because every guarantee lives in the database (row locks, unique indexes, CHECK constraints, triggers) rather than in process memory or in the broker. Design and trade-offs: [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

- Docker with Compose v2 (the stack is Postgres 17, LocalStack 4.14 with SQS, nginx, and the app image)
- Bun 1.3.x (only to run the tests and the CLI scripts; the containers ship their own)

## Quick start

```bash
docker compose up -d --build --wait
```

That brings up Postgres, LocalStack (queues created by `infra/localstack/init-aws.sh`), a one-shot `migrate` service that applies the schema before any replica boots, three replicas of the app (`deploy.replicas: 3`; each serves HTTP and runs the SQS consumer, the outbox publisher and the pending-reference worker), and nginx on `http://localhost:3000` load-balancing over them. `--scale app=3` is also honored if you prefer it explicit.

To run one instance outside Docker against the compose Postgres and LocalStack:

```bash
docker compose up -d --wait postgres localstack
bun install --frozen-lockfile
bun run migrate
SQS_INPUT_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions.fifo bun run start
```

Without `SQS_INPUT_QUEUE_URL` the process serves HTTP only (the consumer is opt-in per process).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | Postgres connection string |
| `SQS_ENDPOINT` | `http://localhost:4566` | SQS endpoint (LocalStack in compose) |
| `AWS_REGION` | `us-east-1` | SQS region |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test` / `test` | Credentials; LocalStack accepts any |
| `SQS_INPUT_QUEUE_URL` | unset | **Opt-in.** URL of `wager-transactions.fifo`; when set, this process consumes it |
| `SQS_DLQ_URL` | `<input queue>` with `.fifo` replaced by `-dlq.fifo` | Dead-letter queue the consumer writes to explicitly |
| `SQS_WAIT_TIME_SECONDS` | `20` | Long-poll length; also the upper bound a graceful stop waits for the current poll |
| `WAGER_EVENTS_QUEUE_URL` | `http://localhost:4566/000000000000/wager-events.fifo` | Queue the outbox publisher sends integration events to |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `2000` | Tick of the pending-reference worker; `0` disables it in this process |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `12` | Retries before a missing reference ends `REJECTED REFERENCE_NOT_FOUND` |
| `PENDING_REFERENCE_TTL_MS` | `86400000` (24 h) | Age cap for the same give-up, whichever limit is hit first |
| `LOG_LEVEL` | `info` | pino level (`.env.test` sets `warn` for the suite) |

## Commands

| Command | What it does |
|---|---|
| `bun run start` | Start one instance (`src/main.ts`) |
| `bun run migrate` / `bun run migrate:down` | Apply / revert the versioned migration (MikroORM Migrator, hand-written SQL) |
| `bun run typecheck` | `tsc --noEmit` in strict mode |
| `bun test` | Unit, integration and concurrency suites. Needs `docker compose up -d --wait postgres localstack`; each test file creates its own database (`test_<file>`) and its own queues, so the dev database is never touched |
| `bun run test:e2e` | Builds and starts the full stack (3 replicas + nginx) and runs `test/e2e/multi-instance.e2e.ts` against `localhost:3000`, including `docker kill` and `docker compose restart` of replicas |

## API examples

Create a wallet (the initial balance becomes an internal `OPENING` credit in the same SQL transaction):

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}'
# 201 {"id":"<walletId>","playerId":"0192f28f-...","balance":{"amount":"100.00","currency":"BRL"},"version":1}
```

Submit a `BET` (the `Idempotency-Key` header is mandatory; recommended format `{providerId}:{externalTransactionId}`):

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:tx-1' -d '{
  "providerId": "provider-a",
  "externalTransactionId": "tx-1",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<walletId>",
  "roundId": "round-1",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
# 200 {"transactionId":"<txId>","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
```

Replay: repeat the exact same request. The answer is the original one (same status, same `transactionId`, the balance observed back then) with `idempotentReplay: true`. The same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A `REFUND` or `ROLLBACK` whose reference has not arrived yet answers `202 PENDING_REFERENCE` and is applied later by the worker.

Read back:

```bash
curl -s localhost:3000/wallets/<walletId>
curl -s localhost:3000/wagering/transactions/<txId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/tx-1
curl -s 'localhost:3000/wallets/<walletId>/ledger?limit=50'            # newest first, follow nextCursor until null
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation       # 200 {storedBalance, calculatedBalance, difference, consistent, checkedEntries}
curl -s localhost:3000/metrics                                           # Prometheus text format
curl -s localhost:3000/health/live ; curl -s localhost:3000/health/ready # ready = Postgres and SQS reachable
```

Send the same operation through the queue (message shape in spec section 10; `messageId` is the inbox key):

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-11-09T12:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"tx-2","idempotencyKey":"provider-a:tx-2","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

HTTP status mapping and the failure-code taxonomy: [ARCHITECTURE.md](ARCHITECTURE.md#failure-taxonomy-and-http-status-mapping).

## Tests

All integration, concurrency and e2e tests run against real PostgreSQL and real LocalStack SQS; neither is mocked anywhere. After every integration and e2e test, `expectMoneyInvariants` asserts on the whole database that `wallet.balance == SUM(ledger)` per wallet, `version == 1 + non-OPENING ledger entries`, exactly one `WalletBalanceChanged` per ledger entry and one status event per decided transaction.

| Group | Files | What it proves |
|---|---|---|
| Unit (`test/unit/`) | `domain/money`, `domain/wallet`, `domain/wager-transaction`, `domain/payload-hash`, `domain/messaging`, `interface/http-contract`, `application/safe-reason` | `Money` scale, rounding and invalid inputs; `Wallet` invariants (version, non-negative, one ledger entry per movement); `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK` rules including the two 80.00 bets on 100.00 in pure code; currency conflicts; same idempotency key with a divergent payload is a conflict, not a replay; outbox backoff and inbox lifecycle |
| Integration (`test/integration/`) | `migrations`, `schema-constraints`, `wallets-api`, `wager-transactions-api`, `wallet-queries-api`, `sqs-consumer`, `outbox-publisher`, `pending-reference-worker`, `pending-reference-failure`, `observability`, `readiness` | Migration up/down/up; every constraint and trigger refuses what it must, asserted by constraint name; atomicity of wallet + ledger + inbox + outbox (nothing is published for a rolled-back transaction); inbox dedup and redelivery; two publishers over one outbox; retry with backoff and DLQ; out-of-order references resolved by the worker; HTTP contract, cursor pagination, reconciliation, metrics, log redaction, readiness |
| Concurrency (`test/concurrency/`) | `wallet-concurrency` | Real parallel transactions across 3 app instances with separate pools in one process: the same bet 50 times in parallel (13.1), two 80.00 bets on 100.00 (13.2), many wallets in parallel (13.3), one locked wallet never blocks another |
| E2E (`test/e2e/`) | `multi-instance.e2e` | 3 OS-level replicas behind nginx (13.4); the same message published three times under different FIFO groups applied once, and a ROLLBACK that arrived before its BET applied once the BET lands (13.7); a replica killed with SIGKILL while requests sit inside their transactions, the client retrying with the same key (13.5, 13.8); graceful restart of every replica under load (13.8); every outbox event delivered to `wager-events.fifo` and seen exactly once by a consumer deduplicating by `eventId` (13.6) |

Mapping to the spec's mandatory concurrency list (section 13): 1 and 2 in `wallet-concurrency` and `multi-instance.e2e`; 3 in both; 4 in `multi-instance.e2e`; 5 in `sqs-consumer` ("died after the commit and before the ack") and `multi-instance.e2e` (SIGKILL); 6 in `outbox-publisher` ("two app instances sharing the outbox") and `multi-instance.e2e`; 7 in `pending-reference-worker` and `multi-instance.e2e`; 8 in `multi-instance.e2e` (SIGKILL and graceful restart, invariants checked after each).

Races are forced deterministically instead of relying on timing: the test holds `FOR SHARE` on the wallet row, waits in `pg_stat_activity` until the competing requests are parked on the lock, then releases. The worst interleaving happens on every run.

## Project layout

```
src/
  domain/            Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/OutboxMessage, events, failure codes. No framework imports.
  application/       Use cases (submit, create wallet, publish outbox, process pending references, reconcile, queries), ports, input parsing, log context.
  infrastructure/    MikroORM EntitySchemas + unit of work, migration, SQS consumer/publisher, outbox loop, pending-reference worker, pino logger, prom-client metrics.
  interface/http/    Controllers, HTTP contract (status tables), error filter, no-op AuthGuard, request logging.
test/
  unit/ integration/ concurrency/ e2e/   plus integration/support (per-file database, per-file queues, invariants)
infra/
  localstack/init-aws.sh   creates the three FIFO queues with the redrive policy
  nginx/nginx.conf         upstream over the app replicas via Docker DNS
spike/orm-spike.ts         the one-hour spike that fixed the ORM choice (kept as evidence; not part of the suite)
docker-compose.yml, Dockerfile, .github/workflows/ci.yml
```
