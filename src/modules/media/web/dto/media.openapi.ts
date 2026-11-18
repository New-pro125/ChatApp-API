/// <reference types="zod-openapi" />
import { apiErrorResponseSchema, successEnvelope } from '@/core/http/openapi/openapi.schemas.js';
import type { OpenApiResponseContract, RouteContract } from '@/core/http/openapi/openapi.types.js';
import {
  createUploadSchema,
  downloadTicketSchema,
  mediaParamsSchema,
  uploadTicketSchema,
} from '@/modules/media/web/dto/media.schemas.js';

const bearerSecurity = [{ bearerAuth: [] }] as const;
const errorSchema = apiErrorResponseSchema;

const errorResponse = (description: string): OpenApiResponseContract => ({
  description,
  schema: errorSchema,
});

const mediaErrors = {
  400: errorResponse('Invalid content type or size'),
  401: errorResponse('Authentication is required'),
  403: errorResponse('A verified email is required'),
  404: errorResponse('Media object not found'),
  409: errorResponse('Media object is not ready'),
  422: errorResponse('The uploaded file is infected'),
  429: errorResponse('Too many media requests'),
  500: errorResponse('Unexpected server error'),
  503: errorResponse('Virus scanning is temporarily unavailable'),
};

const uploadResponse = successEnvelope(uploadTicketSchema, 'UploadTicketResponse');
const downloadResponse = successEnvelope(downloadTicketSchema, 'DownloadTicketResponse');

export const mediaContracts = {
  createUpload: {
    operationId: 'media.createUpload',
    tags: ['Media'],
    summary: 'Request a presigned media upload',
    description:
      'Creates a pending media object with a server-generated object key and returns a short-lived presigned PUT URL that signs the exact content type and byte length. The bucket is private.',
    security: bearerSecurity,
    request: { body: createUploadSchema },
    responses: {
      201: { description: 'Upload ticket created', schema: uploadResponse },
      ...mediaErrors,
    },
  },
  finalize: {
    operationId: 'media.finalize',
    tags: ['Media'],
    summary: 'Recheck, scan, and finalize an upload',
    description:
      'Verifies S3 metadata, streams the object through ClamAV, hashes clean bytes, and returns a presigned GET URL. An outage leaves the row pending; an infection quarantines it.',
    security: bearerSecurity,
    request: { params: mediaParamsSchema },
    responses: {
      200: { description: 'Object is ready', schema: downloadResponse },
      ...mediaErrors,
    },
  },
  download: {
    operationId: 'media.download',
    tags: ['Media'],
    summary: 'Get a fresh presigned download URL',
    description: 'Returns a short-lived presigned GET URL for a ready object owned by the caller.',
    security: bearerSecurity,
    request: { params: mediaParamsSchema },
    responses: {
      200: { description: 'Download ticket', schema: downloadResponse },
      ...mediaErrors,
    },
  },
  delete: {
    operationId: 'media.delete',
    tags: ['Media'],
    summary: 'Delete a media object',
    description: 'Deletes the S3 object and its row. Cross-user access returns 404.',
    security: bearerSecurity,
    request: { params: mediaParamsSchema },
    responses: { 204: { description: 'No content' }, ...mediaErrors },
  },
} satisfies Record<string, RouteContract>;
