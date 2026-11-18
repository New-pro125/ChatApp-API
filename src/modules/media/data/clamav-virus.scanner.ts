import { connect, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import type { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';
import type { ScanResult, VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

/** Streams objects to clamd using the INSTREAM protocol with a hard timeout. */
@injectable()
export class ClamAvVirusScanner implements VirusScanner {
  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(MEDIA_TYPES.ClamAvProtocol) private readonly protocol: ClamAvProtocol,
  ) {}

  scan(stream: Readable): Promise<ScanResult> {
    const { host, port, timeoutMs } = this.config.clamAv;

    return new Promise<ScanResult>((resolve, reject) => {
      const socket: Socket = connect({ host, port });
      const decoder = new StringDecoder('utf8');
      let response = '';
      let settled = false;
      let socketReady = false;
      let streamEnded = stream.readableEnded;
      let terminatorSent = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onDrain = (): void => {
        if (!settled) {
          stream.resume();
        }
      };

      // Single terminal path: clear the wall-clock timer and detach backpressure state.
      const cleanup = (): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        socket.off('drain', onDrain);
        stream.destroy();
        socket.destroy();
        return true;
      };

      // Fail closed with a sanitized error; never propagate raw socket or protocol text.
      const fail = (): void => {
        if (cleanup()) {
          reject(new VirusScannerException('Virus scan failed'));
        }
      };

      const succeed = (result: ScanResult): void => {
        if (cleanup()) {
          resolve(result);
        }
      };

      const writeTerminator = (): void => {
        if (settled || !socketReady || terminatorSent) {
          return;
        }
        terminatorSent = true;
        socket.write(this.protocol.terminator(), (terminatorError) => {
          if (terminatorError) {
            fail();
          }
        });
      };

      // Inactivity timeouts can be reset by a daemon that keeps trickling bytes, so bound the
      // whole exchange with a wall-clock deadline as well.
      timer = setTimeout(() => fail(), timeoutMs);

      socket.setTimeout(timeoutMs, () => fail());
      socket.once('error', () => fail());
      socket.once('close', () => {
        if (!settled) {
          fail();
        }
      });
      socket.on('drain', onDrain);
      socket.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        response += decoder.write(chunk);

        // Check framing before normalization so the trailing newline is still detected.
        if (!response.includes('\n')) {
          return;
        }

        try {
          const normalized = response.replace(/\p{Cc}/gu, ' ');
          succeed(this.protocol.parseResponse(normalized));
        } catch {
          fail();
        }
      });

      // Listeners are attached before connect so an early source error cannot be uncaught, and the
      // stream stays paused until the protocol prefix has been written.
      stream.on('data', (chunk: Buffer) => {
        if (settled || !socketReady) {
          return;
        }
        if (!socket.write(this.protocol.frame(chunk))) {
          stream.pause();
        }
      });
      stream.once('error', () => fail());
      stream.once('end', () => {
        streamEnded = true;
        writeTerminator();
      });
      stream.pause();

      socket.once('connect', () => {
        socket.write('zINSTREAM\n', (writeError) => {
          if (writeError) {
            fail();
            return;
          }

          socketReady = true;
          if (streamEnded) {
            writeTerminator();
            return;
          }
          stream.resume();
        });
      });
    });
  }
}
