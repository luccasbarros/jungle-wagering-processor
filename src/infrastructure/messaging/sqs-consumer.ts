import { Logger } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { InboxMessage } from '../../domain/inbox-message.ts';
import { sha256Hex } from '../../domain/payload-hash.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { DomainError } from '../../domain/errors/domain-errors.ts';
import { parseIdempotencyKey, parseWagerPayload } from '../../application/input.ts';
import { DuplicateInboxMessageError, TransientFailureError, safeReason } from '../../application/errors.ts';
import { logContext } from '../../application/log-context.ts';
import type { Clock } from '../../application/ports/clock.ts';
import type { Metrics } from '../../application/ports/metrics.ts';
import type { UnitOfWork } from '../../application/ports/unit-of-work.ts';
import type { SubmitWagerCommand, SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction.ts';
import type { SqsConsumerConfig } from './sqs.ts';

export const CONSUMER_NAME = 'wager-transactions-consumer';
export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';
/** Same number as RedrivePolicy.maxReceiveCount in infra/localstack/init-aws.sh: the consumer dead-letters with a reason on the last allowed delivery instead of letting the redrive do it silently. */
export const MAX_RECEIVE_COUNT = 5;

const MAX_BATCH = 10;
const RECEIVE_ERROR_PAUSE_MS = 1000;
const RETRY_BACKOFF_CAP_SECONDS = 60;
const MAX_MESSAGE_ID_LENGTH = 255;

/** 2s, 4s, 8s, 16s for deliveries 1..4; the 5th goes to the DLQ. */
export const retryVisibilitySeconds = (receiveCount: number): number => Math.min(2 ** receiveCount, RETRY_BACKOFF_CAP_SECONDS);

export type MessageOutcome = 'committed' | 'replayed' | 'duplicate' | 'terminal' | 'retry' | 'dead-lettered';

const ACKED_OUTCOMES: ReadonlySet<MessageOutcome> = new Set(['committed', 'replayed', 'duplicate', 'terminal', 'dead-lettered']);

const invalid = (message: string) => new DomainError(FailureCode.InvalidPayload, message);

interface ParsedMessage {
  messageId: string;
  command: SubmitWagerCommand;
}

/** Spec section 10 envelope; anything that fails here can never succeed, so it is a permanent failure. */
export function parseEnvelope(body: string | undefined): ParsedMessage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body ?? '');
  } catch {
    throw invalid('message body is not valid JSON');
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) throw invalid('message body must be a JSON object');
  const { messageId, type, data } = envelope as Record<string, unknown>;
  if (type !== WAGER_TRANSACTION_REQUESTED) throw invalid(`type must be ${WAGER_TRANSACTION_REQUESTED}`);
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > MAX_MESSAGE_ID_LENGTH) {
    throw invalid(`messageId must be a non-empty string of at most ${MAX_MESSAGE_ID_LENGTH} characters`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw invalid('data must be a JSON object');
  const idempotencyKey = parseIdempotencyKey((data as Record<string, unknown>).idempotencyKey);
  return { messageId, command: { idempotencyKey, payload: parseWagerPayload(data), correlationId: messageId } };
}

export class SqsConsumer {
  private readonly logger = new Logger(SqsConsumer.name);
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly submit: SubmitWagerTransaction,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly config: SqsConsumerConfig,
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** SIGTERM path: let the current poll end (aborting it client-side would leave what it delivers invisible until the visibility timeout), finish the message in flight, hand the rest of the batch back. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.loop = undefined;
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  // before, not on, ApplicationShutdown: the message in flight must commit while the ORM is still open.
  beforeApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const messages = await this.receive();
      for (const [index, message] of messages.entries()) {
        if (this.stopping) {
          await this.returnToQueue(messages.slice(index));
          break;
        }
        try {
          await this.processAndAck(message);
        } catch (error) {
          // SQS itself failed (visibility, DLQ send or ack): the message comes back after its visibility timeout.
          this.logger.error(`broker call failed for message ${message.MessageId}: ${safeReason(error)}`);
        }
      }
    }
  }

  private async processAndAck(message: Message): Promise<void> {
    const outcome = await this.handle(message);
    if (ACKED_OUTCOMES.has(outcome)) await this.ack(message);
  }

  /** Processes one delivery without acknowledging it; the caller decides on the ack from the outcome. */
  async handle(message: Message): Promise<MessageOutcome> {
    const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
    let parsed: ParsedMessage;
    try {
      parsed = parseEnvelope(message.Body);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return this.deadLetter(message, error.code, error.message);
    }
    const { messageId, command } = parsed;
    // Every log line of this message carries the ids; the use case assigns transactionId and status as it goes.
    return logContext.run({ messageId, correlationId: command.correlationId, walletId: command.payload.walletId, providerId: command.payload.providerId }, () =>
      this.process(message, messageId, command, receiveCount),
    );
  }

  private async process(message: Message, messageId: string, command: SubmitWagerCommand, receiveCount: number): Promise<MessageOutcome> {
    const now = this.clock.now();
    const inbox = InboxMessage.receive({ messageId, consumerName: CONSUMER_NAME, payloadHash: sha256Hex(message.Body ?? ''), receivedAt: now });
    inbox.markProcessed(now);

    try {
      const { transaction, idempotentReplay } = await this.submit.execute(command, inbox);
      if (idempotentReplay) {
        this.logger.log(`message replayed transaction ${transaction.id}`);
        return 'replayed';
      }
      this.logger.log(`message committed transaction ${transaction.id} as ${transaction.status}`);
      return 'committed';
    } catch (error) {
      // Thrown by the use case on both paths (inside the effect's transaction, or alone on a replay): the inbox already knew this messageId.
      if (error instanceof DuplicateInboxMessageError) return this.duplicate();
      if (error instanceof DomainError && error.code === FailureCode.IdempotencyConflict) {
        // Business refusal that never persists a row: terminal for the queue, so the message is consumed and remembered.
        if (!(await this.recordInbox(inbox))) return this.duplicate();
        logContext.assign({ failureCode: error.code });
        this.logger.warn(`message refused: ${error.message}`);
        return 'terminal';
      }
      if (error instanceof DomainError) return this.deadLetter(message, error.code, error.message);
      if (receiveCount >= MAX_RECEIVE_COUNT) {
        const code = error instanceof TransientFailureError ? FailureCode.TransientFailure : FailureCode.PermanentFailure;
        return this.deadLetter(message, code, `gave up after ${receiveCount} deliveries: ${safeReason(error)}`);
      }
      if (!(error instanceof TransientFailureError)) this.logger.error(`unexpected error, will retry: ${safeReason(error)}`);
      return this.retryLater(message, receiveCount);
    }
  }

  private duplicate(): MessageOutcome {
    this.metrics.duplicateDetected('inbox');
    this.logger.log('message already in the inbox, acked without effect');
    return 'duplicate';
  }

  /** Short transaction for paths where the use case wrote nothing; false when the inbox already had this messageId. */
  private async recordInbox(inbox: InboxMessage): Promise<boolean> {
    try {
      await this.uow.transaction((r) => r.inbox.add(inbox));
      return true;
    } catch (error) {
      if (error instanceof DuplicateInboxMessageError) return false;
      throw error;
    }
  }

  private async retryLater(message: Message, receiveCount: number): Promise<MessageOutcome> {
    const seconds = retryVisibilitySeconds(receiveCount);
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }));
    this.metrics.retried('message_redelivery');
    this.logger.warn(`delivery ${receiveCount} failed transiently, visible again in ${seconds}s`);
    return 'retry';
  }

  /** The original body travels untouched so an operator can redrive it; the reason rides in message attributes. */
  private async deadLetter(message: Message, failureCode: FailureCode, reason: string): Promise<MessageOutcome> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.config.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? CONSUMER_NAME,
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: failureCode },
          failureReason: { DataType: 'String', StringValue: reason },
          sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? '' },
        },
      }),
    );
    this.metrics.deadLettered();
    logContext.assign({ failureCode });
    this.logger.warn(`message ${message.MessageId} dead-lettered: ${reason}`);
    return 'dead-lettered';
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async returnToQueue(messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
    }
    if (messages.length > 0) this.logger.log(`stopping: ${messages.length} unstarted message(s) returned to the queue`);
  }

  private async receive(): Promise<Message[]> {
    try {
      const { Messages } = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.config.queueUrl,
          MaxNumberOfMessages: MAX_BATCH,
          WaitTimeSeconds: this.config.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
      );
      return Messages ?? [];
    } catch (error) {
      if (this.stopping) return [];
      this.logger.error(`receive failed: ${safeReason(error)}`);
      await Bun.sleep(RECEIVE_ERROR_PAUSE_MS);
      return [];
    }
  }
}
