import type { IncomingMessage } from 'node:http';
import { PassThrough, type Readable } from 'node:stream';
import Busboy from 'busboy';
import type { Request } from 'express';
import { injectable } from 'inversify';
import { BadRequestException } from '@/core/errors/http.error.js';
import {
  type CombinedMediaFieldsSchema,
  combinedMediaFieldsSchema,
} from '@/core/media/media-form.schema.js';

export interface ParsedMultipartMedia {
  readonly fields: CombinedMediaFieldsSchema;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly body: Readable;
  assertComplete(): Promise<void>;
}

interface MultipartFields {
  sizeBytes?: string | undefined;
  [name: string]: string | undefined;
}

/** Bounded busboy parser; text fields must precede the single file part. */
@injectable()
export class MultipartMediaParser {
  private static readonly MULTIPART_OVERHEAD_BYTES = 65_536;

  parse(req: Request | IncomingMessage, maxFileBytes: number): Promise<ParsedMultipartMedia> {
    return new Promise((resolve, reject) => {
      // Busboy's part limits cannot bound header and overhead bytes, so enforce
      // the whole-request cap before any multipart parsing begins.
      const declaredLength = req.headers['content-length'];
      if (declaredLength !== undefined) {
        const requestBytes = Number(declaredLength);
        const maxRequestBytes = maxFileBytes + MultipartMediaParser.MULTIPART_OVERHEAD_BYTES;
        if (
          !Number.isSafeInteger(requestBytes) ||
          requestBytes < 0 ||
          requestBytes > maxRequestBytes
        ) {
          reject(new BadRequestException('Multipart request exceeds the maximum allowed size'));
          return;
        }
      }

      let busboy: ReturnType<typeof Busboy>;
      try {
        busboy = Busboy({
          headers: req.headers,
          limits: { files: 1, fields: 7, fieldSize: 8192, fileSize: maxFileBytes, parts: 9 },
        });
      } catch (error) {
        reject(new BadRequestException('Invalid multipart request', { cause: error }));
        return;
      }

      const fields: MultipartFields = {};
      let settled = false;
      let fileSeen = false;
      let fileEnded = false;
      const body = new PassThrough({ highWaterMark: 64 * 1024 });
      let observedBytes = 0;
      let declaredBytes = 0;
      let resolveComplete!: () => void;
      let rejectComplete!: (error: unknown) => void;
      const complete = new Promise<void>((ok, fail) => {
        resolveComplete = ok;
        rejectComplete = fail;
      });
      // A failed parse never reaches a caller that would await assertComplete().
      complete.catch(() => {});

      const failOnce = (error: unknown): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        rejectComplete(error);
      };

      busboy.on('field', (name, value) => {
        if (fileSeen) {
          failOnce(new BadRequestException('Multipart fields must precede the file part'));
          return;
        }
        fields[name] = value;
      });

      busboy.on('file', (_name, stream, info) => {
        if (fileSeen) {
          failOnce(new BadRequestException('Exactly one file is allowed'));
          return;
        }
        fileSeen = true;
        const declared = Number(fields.sizeBytes);
        if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxFileBytes) {
          failOnce(new BadRequestException('sizeBytes must be a positive bounded integer'));
          return;
        }
        declaredBytes = declared;

        stream.on('limit', () => failOnce(new BadRequestException('File exceeds maximum size')));
        stream.on('data', (chunk: Buffer) => {
          observedBytes += chunk.length;
          if (observedBytes > declaredBytes) {
            failOnce(new BadRequestException('File exceeds declared sizeBytes'));
            stream.destroy();
          }
        });
        stream.on('error', failOnce);
        stream.on('end', () => {
          if (observedBytes !== declaredBytes) {
            failOnce(new BadRequestException('File size does not match sizeBytes'));
            return;
          }
          fileEnded = true;
        });
        stream.pipe(body);

        if (settled) {
          return;
        }
        try {
          const parsedFields = combinedMediaFieldsSchema.parse(fields);
          settled = true;
          resolve({
            fields: parsedFields,
            contentType: info.mimeType,
            sizeBytes: declaredBytes,
            body,
            assertComplete: () => complete,
          });
        } catch (error) {
          failOnce(error);
        }
      });

      busboy.on('filesLimit', () =>
        failOnce(new BadRequestException('Exactly one file is allowed')),
      );
      busboy.on('fieldsLimit', () => failOnce(new BadRequestException('Too many form fields')));
      busboy.on('partsLimit', () => failOnce(new BadRequestException('Too many form parts')));
      busboy.on('error', failOnce);
      busboy.on('close', () => {
        if (!fileSeen) {
          failOnce(new BadRequestException('A file part is required'));
          return;
        }
        if (!fileEnded) {
          failOnce(new BadRequestException('File stream ended before the part completed'));
          return;
        }
        resolveComplete();
      });

      req.pipe(busboy);
    });
  }
}
