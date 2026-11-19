import { type Job, Queue, Worker } from 'bullmq';
import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import type { RedisClient } from '@/types/redis.js';

const QUEUE_NAME = 'pin-cleanup';
const JOB_NAME = 'delete-expired-pins';
const REPEAT_KEY = 'pin-cleanup-expired-pins';
const BATCH_SIZE = 100;
const MAX_BATCHES = 100;

/** Owns the repeatable job that physically removes elapsed pin metadata. */
@injectable()
export class PinCleanupWorker {
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
    @inject(CORE_TYPES.RedisClient) private readonly redis: RedisClient,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.queue !== null) {
      return;
    }

    const connection = this.redis;
    this.queue = new Queue(QUEUE_NAME, { connection });
    this.worker = new Worker(QUEUE_NAME, (job: Job) => this.process(job), {
      connection,
      concurrency: 1,
    });
    this.worker.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'Pin cleanup worker error');
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, jobId: job?.id }, 'Pin cleanup job failed');
    });

    await this.queue.upsertJobScheduler(
      REPEAT_KEY,
      { every: this.config.pinCleanup.intervalMinutes * 60_000 },
      {
        name: JOB_NAME,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 100 },
      },
    );
  }

  isRunning(): boolean {
    return this.worker?.isRunning() ?? false;
  }

  async process(_job?: Job): Promise<{ deleted: number }> {
    let deleted = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await this.pins.deleteExpired(new Date(), BATCH_SIZE);
      deleted += removed;

      if (removed < BATCH_SIZE) {
        break;
      }
    }

    this.logger.info({ deleted }, 'Expired message pin cleanup completed');

    return { deleted };
  }

  async close(): Promise<void> {
    const worker = this.worker;
    const queue = this.queue;
    this.worker = null;
    this.queue = null;

    if (worker) {
      await worker.close();
    }

    if (queue) {
      await queue.close();
    }
  }
}
