import { inject, injectable } from 'inversify';
import {
  AccountLockedException,
  EmailAlreadyRegisteredException,
} from '@/core/errors/domain.error.js';
import { UniqueConstraintException } from '@/core/errors/repository.error.js';
import type { RegisterInput } from '@/modules/auth/auth.types.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AccountLockoutService } from '@/modules/auth/logic/account-lockout.service.js';
import { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { AuthenticationResult } from '@/modules/auth/logic/entities/authentication-result.js';
import type { MfaService } from '@/modules/auth/logic/mfa.service.js';
import type { PasswordHasher } from '@/modules/auth/logic/ports/password.hasher.js';
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';

@injectable()
export class AuthService {
  constructor(
    @inject(AUTH_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(AUTH_TYPES.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(AUTH_TYPES.AccountLockoutService)
    private readonly lockout: AccountLockoutService,
    @inject(AUTH_TYPES.MfaService) private readonly mfa: MfaService,
  ) {}

  async register(input: RegisterInput): Promise<AuthenticatedUser> {
    const passwordHash = await this.hasher.hash(input.password);

    try {
      const user = await this.users.create({
        email: input.email.trim().toLowerCase(),
        displayName: input.displayName.trim(),
        passwordHash,
      });

      return AuthenticatedUser.fromRecord(user);
    } catch (error) {
      if (error instanceof UniqueConstraintException) {
        throw new EmailAlreadyRegisteredException('Email is already registered', {
          cause: error,
        });
      }

      throw error;
    }
  }

  async authenticate(
    email: string,
    password: string,
    requestedIp: string | null = null,
  ): Promise<AuthenticationResult | null> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());

    if (!user) {
      await this.hasher.verifyDummy(password);
      return null;
    }

    this.lockout.assertNotLocked(user);

    if (!user.passwordHash) {
      await this.hasher.verifyDummy(password);
      return null;
    }

    const valid = await this.hasher.verify(user.passwordHash, password);

    if (!valid) {
      const state = await this.lockout.recordFailure(user);

      if (state.lockedUntil) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((state.lockedUntil.getTime() - Date.now()) / 1000),
        );

        throw new AccountLockedException(retryAfterSeconds);
      }

      return null;
    }

    await this.lockout.recordSuccess(user);

    if (this.mfa.isAvailable() && user.mfaEnabled) {
      const challenge = await this.mfa.startChallenge(user.id, requestedIp);

      return {
        status: 'mfa_required',
        challengeToken: challenge.challengeToken,
        expiresAt: challenge.expiresAt,
      };
    }

    return { status: 'authenticated', user: AuthenticatedUser.fromRecord(user) };
  }

  async findSessionUser(id: string, sessionVersion: number): Promise<AuthenticatedUser | null> {
    const user = await this.users.findById(id);

    if (!user || user.sessionVersion !== sessionVersion) {
      return null;
    }

    return AuthenticatedUser.fromRecord(user);
  }

  async findById(id: string): Promise<AuthenticatedUser | null> {
    const user = await this.users.findById(id);

    return user ? AuthenticatedUser.fromRecord(user) : null;
  }
}
