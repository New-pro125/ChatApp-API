import type { RequestHandler } from 'express';
import session, { type Store } from 'express-session';
import type { AppConfig } from '@/core/config/app.config.js';
import { SessionCookieOptions } from '@/core/session/session-cookie.js';

export class SessionMiddleware {
  readonly handle: RequestHandler;

  constructor(config: AppConfig, store: Store) {
    this.handle = session({
      store,
      name: config.sessionCookieName,
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        ...new SessionCookieOptions(config).create(),
        maxAge: config.sessionTtlSeconds * 1000,
      },
    });
  }
}
