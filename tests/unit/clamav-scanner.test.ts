import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import { ClamAvVirusScanner } from '@/modules/media/data/clamav-virus.scanner.js';
import { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';

let server: Server | undefined;

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  server = undefined;
});

const startServer = async (reply: string | null): Promise<number> => {
  server = createServer((socket) => {
    socket.once('data', () => {
      if (reply !== null) {
        socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return address.port;
};

const scannerFor = (port: number, timeoutMs = 1000): ClamAvVirusScanner =>
  new ClamAvVirusScanner(
    { clamAv: { host: '127.0.0.1', port, timeoutMs } } as AppConfig,
    new ClamAvProtocol(),
  );

describe('ClamAvVirusScanner', () => {
  it('streams a file through zINSTREAM and reports clean', async () => {
    const port = await startServer('1: OK\n');
    const result = await scannerFor(port).scan(Readable.from([Buffer.from('hello')]));
    expect(result).toEqual({ verdict: 'clean' });
  });

  it('reports an infection with a sanitized signature', async () => {
    const port = await startServer('1: FOUND Eicar-Test-Signature\n');
    const result = await scannerFor(port).scan(Readable.from([Buffer.from('eicar')]));
    expect(result).toEqual({ verdict: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('fails closed when the daemon does not answer', async () => {
    const port = await startServer(null);
    await expect(scannerFor(port, 50).scan(Readable.from([Buffer.from('x')]))).rejects.toThrow(
      VirusScannerException,
    );
  });

  it('strips embedded control characters from the reported signature', async () => {
    const port = await startServer('1: FOUND Eicar\u0000-Test\u0001-Signature\n');
    const result = await scannerFor(port).scan(Readable.from([Buffer.from('eicar')]));
    expect(result.verdict).toBe('infected');
    if (result.verdict === 'infected') {
      expect(result.signature).not.toMatch(/\p{Cc}/u);
    }
  });
});
