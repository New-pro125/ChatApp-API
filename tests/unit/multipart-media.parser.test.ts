import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@/core/errors/http.error.js';
import { MultipartMediaParser } from '@/modules/messages/web/multipart-media.parser.js';

function requestWith(body: Buffer, contentType: string, contentLength?: number) {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (contentLength !== undefined) {
    headers['content-length'] = String(contentLength);
  }

  return {
    headers,
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield body;
    },
    pipe<T>(target: T): T {
      process.nextTick(() => {
        (target as { end: (chunk?: Buffer) => void; write: (chunk: Buffer) => void }).write(body);
        (target as { end: (chunk?: Buffer) => void }).end();
      });
      return target;
    },
  };
}

describe('MultipartMediaParser', () => {
  const boundary = '----testboundary';

  it('parses fields before the file and verifies exact size', async () => {
    const file = Buffer.from('clean-bytes');
    const body =
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n${file.length}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ).toString('utf8') +
      file.toString('utf8') +
      `\r\n--${boundary}--\r\n`;

    const parsed = await new MultipartMediaParser().parse(
      requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
      1000,
    );

    expect(parsed.fields.kind).toBe('image');
    expect(parsed.contentType).toBe('image/png');
    expect(parsed.sizeBytes).toBe(file.length);
    await expect(parsed.assertComplete()).resolves.toBeUndefined();
  });

  it('rejects a file that arrives before sizeBytes', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n--${boundary}--\r\n`;

    await expect(
      new MultipartMediaParser().parse(
        requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
        1000,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a request with no file part', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n3\r\n` +
      `--${boundary}--\r\n`;

    await expect(
      new MultipartMediaParser().parse(
        requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
        1000,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a declared size above the configured maximum', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n1000\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n--${boundary}--\r\n`;

    await expect(
      new MultipartMediaParser().parse(
        requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
        100,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a second file part through assertComplete', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n3\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\n` +
      `Content-Type: image/png\r\n\r\ndef\r\n--${boundary}--\r\n`;

    const parsed = await new MultipartMediaParser().parse(
      requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
      1000,
    );
    await expect(parsed.assertComplete()).rejects.toThrow(BadRequestException);
  });

  it('rejects a short file stream through assertComplete', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n5\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n--${boundary}--\r\n`;

    const parsed = await new MultipartMediaParser().parse(
      requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
      1000,
    );
    await expect(parsed.assertComplete()).rejects.toThrow(BadRequestException);
  });

  it('rejects a Content-Length above the file cap plus multipart overhead', async () => {
    const maxFileBytes = 100;
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n3\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n--${boundary}--\r\n`;

    await expect(
      new MultipartMediaParser().parse(
        requestWith(
          Buffer.from(body),
          `multipart/form-data; boundary=${boundary}`,
          maxFileBytes + 65_537,
        ) as never,
        maxFileBytes,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('accepts a Content-Length exactly at the file cap plus multipart overhead', async () => {
    const maxFileBytes = 100;
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n3\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n--${boundary}--\r\n`;

    const parsed = await new MultipartMediaParser().parse(
      requestWith(
        Buffer.from(body),
        `multipart/form-data; boundary=${boundary}`,
        maxFileBytes + 65_536,
      ) as never,
      maxFileBytes,
    );

    await expect(parsed.assertComplete()).resolves.toBeUndefined();
    expect(parsed.sizeBytes).toBe(3);
  });
});
