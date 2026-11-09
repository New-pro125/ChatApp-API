import type { Container } from 'inversify';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';

declare global {
  namespace Express {
    interface User extends AuthenticatedUser {}

    interface Request {
      requestId: string;
      container: Container;
    }
  }
}
