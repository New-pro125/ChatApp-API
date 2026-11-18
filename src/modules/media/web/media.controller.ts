import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type {
  DownloadTicket,
  MediaService,
  UploadTicket,
} from '@/modules/media/logic/media.service.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import { createUploadSchema, mediaParamsSchema } from '@/modules/media/web/dto/media.schemas.js';

@injectable()
export class MediaController {
  constructor(
    @inject(MEDIA_TYPES.MediaService) private readonly media: MediaService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  createUpload: RequestHandler = async (req, res) => {
    const input = createUploadSchema.parse(req.body);
    const ticket: UploadTicket = await this.media.initiate(
      this.requireUser(req).id,
      input.contentType,
      input.sizeBytes,
    );

    this.response.created(res, {
      mediaId: ticket.mediaId,
      objectKey: ticket.objectKey,
      uploadUrl: ticket.url,
      headers: ticket.headers,
      expiresAt: ticket.expiresAt,
    });
  };

  finalize: RequestHandler = async (req, res) => {
    const { id } = mediaParamsSchema.parse(req.params);
    const result: DownloadTicket = await this.media.finalize(this.requireUser(req).id, id);

    this.response.ok(res, this.toBody(result));
  };

  download: RequestHandler = async (req, res) => {
    const { id } = mediaParamsSchema.parse(req.params);
    const result = await this.media.getDownload(this.requireUser(req).id, id);

    this.response.ok(res, this.toBody(result));
  };

  remove: RequestHandler = async (req, res) => {
    const { id } = mediaParamsSchema.parse(req.params);

    await this.media.remove(this.requireUser(req).id, id);

    this.response.noContent(res);
  };

  private toBody(result: DownloadTicket) {
    return {
      mediaId: result.mediaId,
      status: result.status,
      contentType: result.contentType,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      downloadUrl: result.url,
      expiresAt: result.expiresAt,
    };
  }

  private requireUser(req: Request): Express.User {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
