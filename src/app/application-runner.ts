import type { Application } from '@/app/application.js';
import type { AppContainer } from '@/core/container/app.container.js';

/**
 * Owns process lifecycle concerns: startup, signal handling, and shutdown.
 */
export class ApplicationRunner {
  private shuttingDown: boolean = false;

  constructor(
    private readonly container: AppContainer,
    private readonly application: Application,
  ) {}

  registerSignalHandlers(): void {
    process.once('SIGINT', () => void this.shutdown('SIGINT'));
    process.once('SIGTERM', () => void this.shutdown('SIGTERM'));
  }

  async start(): Promise<void> {
    try {
      await this.application.start();
    } catch (error) {
      this.container.logger.fatal({ err: error }, 'Failed to start the API');
      process.exit(1);
    }
  }

  private async shutdown(signal: NodeJS.Signals): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    this.container.logger.info({ signal }, 'Shutting down');

    try {
      await this.application.stop();
      process.exit(0);
    } catch (error) {
      this.container.logger.error({ err: error }, 'Failed to shut down cleanly');
      process.exit(1);
    }
  }
}
