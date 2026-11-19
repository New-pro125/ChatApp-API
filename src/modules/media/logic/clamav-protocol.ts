import { injectable } from 'inversify';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import type { ScanResult } from '@/modules/media/logic/ports/virus-scanner.js';

const MAX_SIGNATURE_LENGTH = 512;

/** Encodes and decodes clamd INSTREAM framing without needing a live daemon. */
@injectable()
export class ClamAvProtocol {
  frame(chunk: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length, 0);

    return Buffer.concat([length, chunk]);
  }

  terminator(): Buffer {
    return Buffer.alloc(4);
  }

  parseResponse(response: string): ScanResult {
    const prefix = 'stream: ';
    const foundSuffix = ' FOUND';

    if (!response.endsWith('\0')) {
      throw new VirusScannerException('Unexpected ClamAV response');
    }

    const text = response.slice(0, -1);
    if (!text.startsWith(prefix)) {
      throw new VirusScannerException('Unexpected ClamAV response');
    }

    const verdict = text.slice(prefix.length);
    if (verdict === 'OK') {
      return { verdict: 'clean' };
    }

    if (verdict.endsWith(foundSuffix)) {
      const signature = verdict.slice(0, -foundSuffix.length);

      if (signature.length > 0) {
        return { verdict: 'infected', signature: signature.slice(0, MAX_SIGNATURE_LENGTH) };
      }
    }

    throw new VirusScannerException('Unexpected ClamAV response');
  }
}
