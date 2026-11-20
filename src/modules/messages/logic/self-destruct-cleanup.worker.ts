import { type Job, Queue, Worker } from 'bullmq';
import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MentionService } from '@/modules/messages/logic/mention.service.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import type { RedisClient } from '@/types/redis.js';

const QUEUE_NAME = 'self-destruct-cleanup';
const JOB_NAME = 'scrub-expired-messages';
const REPEAT_KEY = 'self-destruct-cleanup-expired-messages';
const BATCH_SIZE = 100;
const MAX_BATCHES = 100;

/** Owns the repeatable job that scrubs elapsed self-destructing messages. */
@injectable()
export class SelfDestructCleanupWorker {
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
    @inject(MESSAGES_TYPES.MentionService) private readonly mentions: MentionService,
    @inject(CORE_TYPES.MediaAccessProvider) private readonly getMediaAccess: () => MediaAccess,
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
      this.logger.error({ err: error }, 'Self-destruct cleanup worker error');
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, jobId: job?.id }, 'Self-destruct cleanup job failed');
    });

    await this.queue.upsertJobScheduler(
      REPEAT_KEY,
      { every: this.config.selfDestructCleanup.intervalMinutes * 60_000 },
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

  async process(_job?: Job): Promise<{ scrubbed: number }> {
    let scrubbed = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const due = await this.messages.listExpired(new Date(), BATCH_SIZE);

      if (due.length === 0) {
        break;
      }

      for (const message of due) {
        // Pins and media are released before the scrub so a release failure
        // leaves the row for the next retry to finish.
        await this.pins.removeForMessage(message.chatId, message.id);
        await this.mentions.hideForMessage(message.chatId, message.id);

        const mediaId = message.media?.mediaId ?? null;

        if (mediaId !== null) {
          await this.getMediaAccess().releaseIfUnreferenced(mediaId);
        }

        if (await this.messages.scrubExpired(message.chatId, message.id, new Date())) {
          scrubbed += 1;
        }
      }
    }

    this.logger.info({ scrubbed }, 'Expired self-destructing message cleanup completed');

    return { scrubbed };
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
