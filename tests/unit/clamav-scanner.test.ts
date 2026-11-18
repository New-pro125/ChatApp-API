import type { AddressInfo, Socket } from 'node:net';
import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import { ClamAvVirusScanner } from '@/modules/media/data/clamav-virus.scanner.js';
import { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';

let server: Server | undefined;
const sockets = new Set<Socket>();

const trackSocket = (socket: Socket): void => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
};

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  if (server?.listening) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  server = undefined;
});

const startServer = async (reply: string | null): Promise<number> => {
  server = createServer((socket) => {
    trackSocket(socket);
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

const startProtocolServer = async (): Promise<{ port: number; received: Promise<Buffer> }> => {
  let resolveReceived: ((bytes: Buffer) => void) | undefined;
  const received = new Promise<Buffer>((resolve) => {
    resolveReceived = resolve;
  });

  server = createServer((socket) => {
    trackSocket(socket);
    const chunks: Buffer[] = [];
    let replied = false;
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (replied) {
        return;
      }

      const bytes = Buffer.concat(chunks);
      if (bytes.length >= 4 && bytes.subarray(-4).equals(Buffer.alloc(4))) {
        replied = true;
        resolveReceived?.(bytes);
        socket.write('1: OK\n');
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { port: address.port, received };
};

const startSplitReplyServer = async (first: Buffer, second: Buffer): Promise<number> => {
  server = createServer((socket) => {
    trackSocket(socket);
    socket.setNoDelay(true);
    socket.once('data', () => {
      socket.write(first);
      setTimeout(() => {
        if (!socket.destroyed) {
          socket.write(second);
        }
      }, 50);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return address.port;
};

const startTricklingServer = async (): Promise<number> => {
  server = createServer((socket) => {
    trackSocket(socket);
    const interval = setInterval(() => {
      if (!socket.destroyed) {
        socket.write('x');
      }
    }, 10);
    socket.once('close', () => clearInterval(interval));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return address.port;
};

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

  it('writes the framed zINSTREAM protocol with a zero-length terminator', async () => {
    const payload = Buffer.from('hello');
    const { port, received } = await startProtocolServer();

    const result = await scannerFor(port).scan(Readable.from([payload]));
    expect(result).toEqual({ verdict: 'clean' });

    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    expect(await received).toEqual(
      Buffer.concat([Buffer.from('zINSTREAM\n'), length, payload, Buffer.alloc(4)]),
    );
  });

  it('decodes multi-byte signatures split across reply chunks', async () => {
    const reply = Buffer.from('1: FOUND Eicar-\u2713Signature\n');
    const splitAt = reply.indexOf(Buffer.from('\u2713')) + 1;
    const port = await startSplitReplyServer(reply.subarray(0, splitAt), reply.subarray(splitAt));

    const result = await scannerFor(port).scan(Readable.from([Buffer.from('eicar')]));
    expect(result).toEqual({ verdict: 'infected', signature: 'Eicar-\u2713Signature' });
  });

  it('times out when a daemon keeps sending bytes without a framed reply', async () => {
    const port = await startTricklingServer();
    const outcome = await Promise.race([
      scannerFor(port, 50)
        .scan(Readable.from([Buffer.from('x')]))
        .then(
          () => 'resolved',
          () => 'rejected',
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 400)),
    ]);

    expect(outcome).toBe('rejected');
  });

  it('pauses the source stream when the socket applies backpressure', async () => {
    const chunks = Array.from({ length: 32 }, () => Buffer.alloc(64 * 1024, 1));
    const stream = Readable.from(chunks);
    const pauseSpy = vi.spyOn(stream, 'pause');
    const resumeSpy = vi.spyOn(stream, 'resume');
    const { port } = await startProtocolServer();

    await expect(scannerFor(port, 2000).scan(stream)).resolves.toEqual({ verdict: 'clean' });
    expect(pauseSpy).toHaveBeenCalled();
    expect(resumeSpy).toHaveBeenCalled();
  });
});
