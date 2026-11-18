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
    const text = response.replace(/^\d+:\s*/, '').trim();

    if (text === 'OK') {
      return { verdict: 'clean' };
    }

    if (text.startsWith('FOUND')) {
      const signature = text.slice('FOUND'.length).trim().slice(0, MAX_SIGNATURE_LENGTH);

      if (signature.length > 0) {
        return { verdict: 'infected', signature };
      }
    }

    throw new VirusScannerException('Unexpected ClamAV response');
  }
}
