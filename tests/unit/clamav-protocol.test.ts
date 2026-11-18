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

  it('parses clamd stream replies', () => {
    expect(protocol.parseResponse('1: OK\n')).toEqual({ verdict: 'clean' });
    expect(protocol.parseResponse('OK')).toEqual({ verdict: 'clean' });
    expect(protocol.parseResponse('1: FOUND Eicar-Test-Signature\n')).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('truncates hostile signatures and rejects malformed responses', () => {
    const long = protocol.parseResponse(`FOUND ${'x'.repeat(900)}`);
    expect(long).toMatchObject({ verdict: 'infected' });
    if (long.verdict === 'infected') {
      expect(long.signature).toHaveLength(512);
    }
    expect(() => protocol.parseResponse('ERROR broken')).toThrow(VirusScannerException);
    expect(() => protocol.parseResponse('FOUND')).toThrow(VirusScannerException);
  });
});
