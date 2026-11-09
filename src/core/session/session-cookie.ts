import type { CookieOptions } from 'express';
import type { AppConfig } from '@/core/config/app.config.js';

export class SessionCookieOptions {
  constructor(private readonly config: AppConfig) {}

  create(): CookieOptions {
    return {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
    };
  }
}
