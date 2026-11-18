/// <reference types="zod-openapi" />
import { z } from 'zod';
import {
  commonErrorResponses,
  conflictErrorResponse,
  successEnvelope,
} from '@/core/http/openapi/openapi.schemas.js';
import type { RouteContract } from '@/core/http/openapi/openapi.types.js';
import {
  bundleParamsSchema,
  deviceRegistrationSchema,
  prekeyReplenishmentSchema,
  userParamsSchema,
} from '@/modules/e2ee/web/dto/e2ee.schemas.js';

const bearerSecurity = [{ bearerAuth: [] }] as const;

const deviceSchema = z
  .object({
    deviceId: z.uuid(),
    userId: z.uuid(),
    identityPublicKey: z.string(),
    signingPublicKey: z.string(),
    identitySignature: z.string(),
    signedPrekeyId: z.number().int().positive(),
    hasOneTimePreKeys: z.boolean(),
    rotatedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'E2eeDevice' });

const bundleSchema = z
  .object({
    deviceId: z.uuid(),
    userId: z.uuid(),
    signingPublicKey: z.string(),
    identityPublicKey: z.string(),
    identitySignature: z.string(),
    signedPrekey: z.object({
      id: z.number().int().positive(),
      publicKey: z.string(),
      signature: z.string(),
    }),
    oneTimePrekey: z.object({ id: z.number().int().positive(), publicKey: z.string() }),
  })
  .meta({ id: 'E2eeBundle' });

const deviceResponse = successEnvelope(deviceSchema, 'E2eeDeviceResponse');
const deviceListResponse = successEnvelope(z.array(deviceSchema), 'E2eeDeviceListResponse');
const bundleResponse = successEnvelope(bundleSchema, 'E2eeBundleResponse');

export const e2eeContracts = {
  registerDevice: {
    operationId: 'e2ee.registerDevice',
    tags: ['E2EE'],
    summary: 'Register the current device',
    description:
      'Stores public key material for the device id derived from the access token. Duplicate registration returns E2EE_DEVICE_CONFLICT.',
    security: bearerSecurity,
    request: { body: deviceRegistrationSchema },
    responses: {
      201: { description: 'The registered device', schema: deviceResponse },
      409: conflictErrorResponse,
      ...commonErrorResponses,
    },
  },
  listDevices: {
    operationId: 'e2ee.listDevices',
    tags: ['E2EE'],
    summary: 'List the caller registered devices',
    security: bearerSecurity,
    responses: {
      200: { description: 'Registered devices', schema: deviceListResponse },
      ...commonErrorResponses,
    },
  },
  listUserDevices: {
    operationId: 'e2ee.listUserDevices',
    tags: ['E2EE'],
    summary: 'List the public devices registered by another user',
    description:
      'Lets an authenticated client discover a peer device before fetching its bundle. The peer does not need to authenticate. Only public key material and rotation metadata are returned; clients must verify that identitySignature is a valid Ed25519 signature by signingPublicKey over the UTF-8 bytes `e2ee-identity:` followed by the raw identityPublicKey bytes.',
    security: bearerSecurity,
    request: { params: userParamsSchema },
    responses: {
      200: { description: 'The peer public devices', schema: deviceListResponse },
      ...commonErrorResponses,
    },
  },
  rotateDevice: {
    operationId: 'e2ee.rotateDevice',
    tags: ['E2EE'],
    summary: 'Rotate keys for the current device',
    security: bearerSecurity,
    request: { body: deviceRegistrationSchema },
    responses: {
      200: { description: 'The rotated device', schema: deviceResponse },
      409: conflictErrorResponse,
      ...commonErrorResponses,
    },
  },
  replenishPrekeys: {
    operationId: 'e2ee.replenishPrekeys',
    tags: ['E2EE'],
    summary: 'Add one-time prekeys for the current device',
    security: bearerSecurity,
    request: { body: prekeyReplenishmentSchema },
    responses: {
      204: { description: 'No content' },
      409: conflictErrorResponse,
      ...commonErrorResponses,
    },
  },
  bundle: {
    operationId: 'e2ee.bundle',
    tags: ['E2EE'],
    summary: 'Fetch a public key bundle and consume one one-time prekey',
    security: bearerSecurity,
    request: { params: bundleParamsSchema },
    responses: {
      200: { description: 'The key bundle', schema: bundleResponse },
      409: conflictErrorResponse,
      ...commonErrorResponses,
    },
  },
} as const satisfies Record<string, RouteContract>;
