import type { AuthModule } from '@/modules/auth/auth.module.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { BlockService } from '@/modules/auth/logic/block.service.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { makeE2eeRegistration } from '../../helpers/e2ee-keys.js';
import type { TestApp } from '../../helpers/test-app.js';

export interface ApiUser {
  readonly id: string;
  readonly displayName: string;
  readonly headers: Record<string, string>;
}

/** Shared setup for the messaging HTTP integration tests. */
export class MessagingApiFixture {
  readonly auth: AuthFixture;

  constructor(private readonly app: TestApp) {
    this.auth = new AuthFixture(app);
  }

  async verifiedUser(displayName: string): Promise<ApiUser> {
    const user = await this.auth.createUser({ displayName, emailVerifiedAt: new Date() });
    const tokens = await this.auth.mintTokens(user);

    return {
      id: user.id,
      displayName,
      headers: this.auth.bearerHeader(tokens.accessToken),
    };
  }

  async unverifiedUser(displayName: string): Promise<ApiUser> {
    const user = await this.auth.createUser({ displayName, emailVerifiedAt: null });
    const tokens = await this.auth.mintTokens(user);

    return {
      id: user.id,
      displayName,
      headers: this.auth.bearerHeader(tokens.accessToken),
    };
  }

  async block(blockerId: string, blockedId: string): Promise<void> {
    const authModule = this.app.application.getModule<AuthModule>('auth');

    if (!authModule) {
      throw new Error('AuthModule is not registered in the application');
    }

    await authModule.authContainer
      .get<BlockService>(AUTH_TYPES.BlockService)
      .block(blockerId, blockedId);
  }

  async openDirectChat(participantId: string, headers: Record<string, string>): Promise<string> {
    const response = await this.app.request.post('/api/chats').set(headers).send({ participantId });

    if (response.status !== 201) {
      throw new Error(`Could not open a direct chat: ${response.status} ${response.text}`);
    }

    return response.body.data.id as string;
  }

  async registerDevice(
    user: ApiUser,
    oneTimePrekeyCount = 2,
  ): Promise<{ deviceId: string; registration: ReturnType<typeof makeE2eeRegistration> }> {
    const registration = makeE2eeRegistration(oneTimePrekeyCount);
    const response = await this.app.request
      .post('/api/e2ee/devices')
      .set(user.headers)
      .send(registration);

    if (response.status !== 201) {
      throw new Error(`Could not register an E2EE device: ${response.status} ${response.text}`);
    }

    return { deviceId: response.body.data.deviceId as string, registration };
  }

  async openSecretChat(participantId: string, headers: Record<string, string>): Promise<string> {
    const response = await this.app.request
      .post('/api/chats/secret')
      .set(headers)
      .send({ participantId });

    if (response.status !== 201) {
      throw new Error(`Could not open a secret chat: ${response.status} ${response.text}`);
    }

    return response.body.data.id as string;
  }
}
