import { createServer, type RequestListener, type Server } from 'node:http';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';

/**
 * Owns the raw HTTP server and its production timeouts.
 *
 * Express only receives the request listener. Socket-level limits, header
 * limits, malformed-request handling, and graceful shutdown all live here so
 * the Express application stays focused on routing and middleware.
 */
export class HttpServer {
  private readonly server: Server;

  constructor(
    app: RequestListener,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    const { http } = config;

    this.server = createServer(
      {
        maxHeaderSize: http.maxHeaderSizeBytes,
        requestTimeout: http.requestTimeoutMs,
        headersTimeout: http.headersTimeoutMs,
        keepAliveTimeout: http.keepAliveTimeoutMs,
        connectionsCheckingInterval: http.connectionsCheckingIntervalMs,
      },
      app,
    );

    this.server.maxRequestsPerSocket = http.maxRequestsPerSocket;

    this.server.on('clientError', (error, socket) => {
      this.logger.warn({ err: error }, 'Rejected malformed HTTP request');

      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } else {
        socket.destroy();
      }
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };

      this.server.once('error', onError);
      this.server.listen(this.config.port, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  /**
   * Stops accepting connections, drains idle sockets, and force-closes
   * everything still open after `HTTP_SHUTDOWN_TIMEOUT_MS`.
   */
  async close(): Promise<void> {
    if (!this.server.listening) {
      return;
    }

    const timeoutMs = this.config.http.shutdownTimeoutMs;

    await new Promise<void>((resolve, reject) => {
      const forceTimer = setTimeout(() => {
        this.logger.warn(
          { timeoutMs },
          'Graceful shutdown timed out; closing remaining connections',
        );

        this.server.closeAllConnections();
        resolve();
      }, timeoutMs);

      forceTimer.unref();

      this.server.close((error) => {
        clearTimeout(forceTimer);

        if (error) {
          reject(error);
          return;
        }

        resolve();
      });

      this.server.closeIdleConnections();
    });
  }
}
