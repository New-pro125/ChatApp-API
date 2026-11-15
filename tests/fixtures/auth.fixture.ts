import type { AuthModule } from '@/modules/auth/auth.module.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { DeviceContext } from '@/modules/auth/logic/entities/refresh-token-record.js';
import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';
import type { EmailSender } from '@/modules/auth/logic/ports/email.sender.js';
import type { PasswordHasher } from '@/modules/auth/logic/ports/password.hasher.js';
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';
import type { IssuedTokens, TokenService } from '@/modules/auth/logic/token.service.js';
import type { TestApp } from '../helpers/test-app.js';
import { CapturingEmailSender } from './capturing-email.sender.js';

export interface TestUserRegistration {
  email?: string;
  displayName?: string;
  password?: string;
  emailVerifiedAt?: Date | null;
}

export class AuthFixture {
  readonly emails = new CapturingEmailSender();

  private readonly tokenService: TokenService;
  private readonly userRepository: UserRepository;
  private readonly passwordHasher: PasswordHasher;

  constructor(private readonly app: TestApp) {
    const authModule = app.application.getModule<AuthModule>('auth');

    if (!authModule) {
      throw new Error('AuthModule is not registered in the application');
    }

    const container = authModule.authContainer;

    // Replace the configured sender before any email-using service is resolved
    // so tests can read the codes that would have been mailed.
    container.rebind<EmailSender>(AUTH_TYPES.EmailSender).toConstantValue(this.emails);

    this.tokenService = container.get<TokenService>(AUTH_TYPES.TokenService);
    this.userRepository = container.get<UserRepository>(AUTH_TYPES.UserRepository);
    this.passwordHasher = container.get<PasswordHasher>(AUTH_TYPES.PasswordHasher);
  }

  async register(params: TestUserRegistration = {}) {
    const email =
      params.email ?? `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
    const displayName = params.displayName ?? 'Test User';
    const password = params.password ?? 'Str0ngP@ssw0rd!23';

    const response = await this.app.request
      .post('/api/auth/register')
      .send({ email, displayName, password });

    return {
      response,
      email,
      displayName,
      password,
    };
  }

  async createUser(params: TestUserRegistration = {}): Promise<UserRecord> {
    const email =
      params.email ?? `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
    const displayName = params.displayName ?? 'Test User';
    const password = params.password ?? 'Str0ngP@ssw0rd!23';
    const passwordHash = await this.passwordHasher.hash(password);

    return this.userRepository.create({
      email,
      displayName,
      passwordHash,
      emailVerifiedAt: params.emailVerifiedAt ?? null,
    });
  }

  mintTokens(
    user: AuthenticatedUser | UserRecord,
    device: DeviceContext = { clientIp: '127.0.0.1', userAgent: 'test-agent' },
  ): Promise<IssuedTokens> {
    const authUser = user instanceof AuthenticatedUser ? user : AuthenticatedUser.fromRecord(user);

    return this.tokenService.issue(authUser, device);
  }

  bearerHeader(token: string): { Authorization: string } {
    return { Authorization: `Bearer ${token}` };
  }
}
