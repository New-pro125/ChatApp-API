import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { AccountLockedException } from '@/core/errors/domain.error.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';

export class LockoutState {
  constructor(
    readonly attempts: number,
    readonly lockedUntil: Date | null,
  ) {}
}

@injectable()
export class AccountLockoutService {
  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(AUTH_TYPES.UserRepository) private readonly users: UserRepository,
  ) {}

  assertNotLocked(user: UserRecord): void {
    if (!user.lockedUntil) {
      return;
    }

    const now = Date.now();
    const lockedUntil = user.lockedUntil.getTime();

    if (lockedUntil <= now) {
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil - now) / 1000));

    throw new AccountLockedException(retryAfterSeconds);
  }

  async recordFailure(user: UserRecord): Promise<LockoutState> {
    const now = new Date();
    const windowStart = now.getTime() - this.config.lockout.windowSeconds * 1000;
    const inWindow =
      user.lastFailedLoginAt !== null && user.lastFailedLoginAt.getTime() >= windowStart;
    const attempts = inWindow ? user.failedLoginAttempts + 1 : 1;

    const lockedUntil =
      attempts >= this.config.lockout.maxAttempts
        ? new Date(now.getTime() + this.config.lockout.lockoutSeconds * 1000)
        : null;

    await this.users.updateLoginFailure(user.id, attempts, now, lockedUntil);

    return new LockoutState(attempts, lockedUntil);
  }

  async recordSuccess(user: UserRecord): Promise<void> {
    if (user.failedLoginAttempts === 0 && user.lockedUntil === null) {
      return;
    }

    await this.users.clearLoginFailures(user.id);
  }
}
