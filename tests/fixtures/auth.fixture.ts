import type { Container } from 'inversify';
import type { AuthModule } from '@/modules/auth/auth.module.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { OAuthProfile } from '@/modules/auth/logic/entities/oauth-profile.js';
import type { DeviceContext } from '@/modules/auth/logic/entities/refresh-token-record.js';
import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';
import type { CaptchaVerifier } from '@/modules/auth/logic/ports/captcha.verifier.js';
import type { EmailSender } from '@/modules/auth/logic/ports/email.sender.js';
import type { OAuthAccountRepository } from '@/modules/auth/logic/ports/oauth-account.repository.js';
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

  private readonly container: Container;
  private readonly tokenService: TokenService;
  private readonly userRepository: UserRepository;
  private readonly passwordHasher: PasswordHasher;
  private readonly oauthAccounts: OAuthAccountRepository;

  constructor(private readonly app: TestApp) {
    const authModule = app.application.getModule<AuthModule>('auth');

    if (!authModule) {
      throw new Error('AuthModule is not registered in the application');
    }

    this.container = authModule.authContainer;

    // Replace the configured sender before any email-using service is resolved
    // so tests can read the codes that would have been mailed.
    this.container.rebind<EmailSender>(AUTH_TYPES.EmailSender).toConstantValue(this.emails);

    this.tokenService = this.container.get<TokenService>(AUTH_TYPES.TokenService);
    this.userRepository = this.container.get<UserRepository>(AUTH_TYPES.UserRepository);
    this.passwordHasher = this.container.get<PasswordHasher>(AUTH_TYPES.PasswordHasher);
    this.oauthAccounts = this.container.get<OAuthAccountRepository>(
      AUTH_TYPES.OAuthAccountRepository,
    );
  }

  /**
   * Replaces the captcha verifier before the first request resolves
   * `CaptchaService`, letting tests exercise the enabled flow without calling
   * Cloudflare.
   */
  useCaptchaVerifier(verifier: CaptchaVerifier): void {
    this.container.rebind<CaptchaVerifier>(AUTH_TYPES.CaptchaVerifier).toConstantValue(verifier);
  }

  async register(params: TestUserRegistration = {}) {
    const email =
      params.email ?? `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
    const displayName = params.displayName ?? 'Test User';
    const password = params.password ?? 'Str0ngP@ssw0rd!23';

    const response = await this.app.request
      .post('/api/auth/register')
      .send({ email, displayName, password });

    if (response.status === 201) {
      // Registration dispatches the initial code without waiting for SMTP, so
      // tests wait for the captured code before asserting on it.
      await this.waitForVerificationCode(email);
    }

    return {
      response,
      email,
      displayName,
      password,
    };
  }

  async waitForVerificationCode(email: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const code = this.emails.verificationCodeFor(email);

      if (code) {
        return code;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for a verification code for ${email}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  linkOAuth(profile: OAuthProfile): Promise<UserRecord> {
    if (profile.email === null) {
      throw new Error('linkOAuth requires a verified email');
    }

    return this.oauthAccounts.resolve(profile as OAuthProfile & { readonly email: string });
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
