import { connect, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
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
      let response = '';
      let settled = false;

      // Fail closed with a sanitized error; never propagate raw socket or protocol text.
      const fail = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        stream.destroy();
        socket.destroy();
        reject(new VirusScannerException('Virus scan failed'));
      };

      const succeed = (result: ScanResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        stream.destroy();
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(timeoutMs, () => fail());
      socket.once('error', () => fail());
      socket.once('close', () => {
        if (!settled) {
          fail();
        }
      });

      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');

        // Check framing before normalization so the trailing newline is still detected.
        if (!response.includes('\n') || settled) {
          return;
        }

        try {
          const normalized = response.replace(/\p{Cc}/gu, ' ');
          succeed(this.protocol.parseResponse(normalized));
        } catch {
          fail();
        }
      });

      socket.once('connect', () => {
        socket.write('zINSTREAM\n', (writeError) => {
          if (writeError) {
            fail();
            return;
          }

          stream.on('data', (chunk: Buffer) => {
            socket.write(this.protocol.frame(chunk));
          });
          stream.once('error', () => fail());
          stream.once('end', () => {
            socket.write(this.protocol.terminator(), (terminatorError) => {
              if (terminatorError) {
                fail();
              }
            });
          });
        });
      });
    });
  }
}
