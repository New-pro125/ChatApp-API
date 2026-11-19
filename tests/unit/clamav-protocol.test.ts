import { describe, expect, it } from 'vitest';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';

const protocol = new ClamAvProtocol();

describe('ClamAvProtocol', () => {
  it('frames chunks with a big-endian length and terminates with zero', () => {
    const frame = protocol.frame(Buffer.from('abc'));
    expect(frame.subarray(0, 4).readUInt32BE(0)).toBe(3);
    expect(frame.subarray(4).toString()).toBe('abc');
    expect(protocol.terminator()).toEqual(Buffer.alloc(4));
  });

  it('parses NUL-terminated clamd stream replies', () => {
    expect(protocol.parseResponse('stream: OK\0')).toEqual({ verdict: 'clean' });
    expect(protocol.parseResponse('stream: Eicar-Test-Signature FOUND\0')).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    expect(protocol.parseResponse('stream: Phishing.URL (Heuristic Variant) FOUND\0')).toEqual({
      verdict: 'infected',
      signature: 'Phishing.URL (Heuristic Variant)',
    });
  });

  it('truncates hostile signatures and rejects malformed responses', () => {
    const long = protocol.parseResponse(`stream: ${'x'.repeat(900)} FOUND\0`);
    expect(long).toMatchObject({ verdict: 'infected' });
    if (long.verdict === 'infected') {
      expect(long.signature).toHaveLength(512);
    }

    for (const malformed of [
      'OK',
      'OK\0',
      'stream: OK',
      'stream: OK\n',
      '1: OK\0',
      'ERROR broken\0',
      'stream: FOUND\0',
    ]) {
      expect(() => protocol.parseResponse(malformed)).toThrow(VirusScannerException);
    }
  });
});
