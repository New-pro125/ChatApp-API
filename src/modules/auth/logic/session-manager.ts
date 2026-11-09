import type { Request } from 'express';
import { injectable } from 'inversify';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';

@injectable()
export class SessionManager {
  establish(req: Request, user: AuthenticatedUser): Promise<void> {
    return new Promise((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) {
          reject(error);
          return;
        }

        req.logIn(user, (loginError) => {
          if (loginError) {
            reject(loginError);
            return;
          }

          resolve();
        });
      });
    });
  }

  destroy(req: Request): Promise<void> {
    return new Promise((resolve, reject) => {
      req.logout((error) => {
        if (error) {
          reject(error);
          return;
        }

        req.session.destroy((destroyError) => {
          if (destroyError) {
            reject(destroyError);
            return;
          }

          resolve();
        });
      });
    });
  }
}
