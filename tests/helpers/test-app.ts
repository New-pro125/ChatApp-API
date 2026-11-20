import type { Pool } from 'pg';
import supertest, { type Agent } from 'supertest';
import { Application } from '@/app/application.js';
import { AppContainer } from '@/core/container/app.container.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import type { RedisClient } from '@/types/redis.js';

export class TestApp {
  readonly pool: Pool;
  readonly db: AppDatabase;
  readonly redis: RedisClient;
  readonly request: Agent;

  private constructor(
    readonly application: Application,
    readonly container: AppContainer,
  ) {
    this.pool = container.get<Pool>(CORE_TYPES.PgPool);
    this.db = container.get<AppDatabase>(CORE_TYPES.Db);
    this.redis = container.get<RedisClient>(CORE_TYPES.RedisClient);
    this.request = supertest.agent(application.expressApp);
  }

  static async create(): Promise<TestApp> {
    const container = new AppContainer();
    const application = new Application(container);

    await application.initialize();

    return new TestApp(application, container);
  }

  async clearDatabase(): Promise<void> {
    await this.pool.query(`
      TRUNCATE TABLE
        chat_members,
        chats,
        email_verification_codes,
        media_objects,
        message_pins,
        message_mentions,
        messages,
        mfa_challenges,
        mfa_recovery_codes,
        oauth_accounts,
        password_reset_codes,
        refresh_tokens,
        stories,
        user_blocks,
        user_privacy_settings,
        e2ee_prekeys,
        e2ee_devices,
        users
      CASCADE;
    `);

    await this.redis.flushDb();
  }

  async close(): Promise<void> {
    await this.application.stop();
  }
}
