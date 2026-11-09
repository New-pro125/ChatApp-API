import { type Logger, pino } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';

export class LoggerProvider {
  readonly logger: Logger;

  constructor(config: AppConfig) {
    this.logger = pino({
      level: config.logLevel,
      base: null,
    });
  }
}
