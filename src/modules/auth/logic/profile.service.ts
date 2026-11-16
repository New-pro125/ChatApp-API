import { inject, injectable } from 'inversify';
import {
  PhoneAlreadyRegisteredException,
  UserNotFoundException,
  UsernameAlreadyTakenException,
} from '@/core/errors/domain.error.js';
import { UniqueConstraintException } from '@/core/errors/repository.error.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type {
  UpdateProfileInput,
  UserRepository,
} from '@/modules/auth/logic/ports/user.repository.js';

/**
 * Owns self-service changes to the identity row.
 *
 * The web layer validates and normalizes the payload; this service applies it
 * and translates repository uniqueness failures into field-specific domain
 * conflicts so the API can explain which value is already in use.
 */
@injectable()
export class ProfileService {
  constructor(@inject(AUTH_TYPES.UserRepository) private readonly users: UserRepository) {}

  async update(userId: string, input: UpdateProfileInput): Promise<AuthenticatedUser> {
    try {
      const updated = await this.users.updateProfile(userId, input);

      if (!updated) {
        throw new UserNotFoundException();
      }

      return AuthenticatedUser.fromRecord(updated);
    } catch (error) {
      if (error instanceof UniqueConstraintException) {
        if (error.constraint.includes('phone')) {
          throw new PhoneAlreadyRegisteredException(undefined, { cause: error });
        }

        throw new UsernameAlreadyTakenException(undefined, { cause: error });
      }

      throw error;
    }
  }
}
