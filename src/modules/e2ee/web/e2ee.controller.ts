import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { E2EE_TYPES } from '@/modules/e2ee/e2ee.types.js';
import type { E2eeDeviceService } from '@/modules/e2ee/logic/e2ee-device.service.js';
import {
  bundleParamsSchema,
  deviceRegistrationSchema,
  prekeyReplenishmentSchema,
  userParamsSchema,
} from '@/modules/e2ee/web/dto/e2ee.schemas.js';

/** HTTP adapter for E2EE device and public key-bundle operations. */
@injectable()
export class E2eeController {
  constructor(
    @inject(E2EE_TYPES.E2eeDeviceService) private readonly devices: E2eeDeviceService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  register: RequestHandler = async (req, res) => {
    const { userId, deviceId } = this.requireAuth(req);
    const device = await this.devices.register(
      userId,
      deviceId,
      deviceRegistrationSchema.parse(req.body),
    );

    this.response.created(res, this.presentDevice({ device, hasOneTimePreKeys: true }));
  };

  listMine: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const devices = await this.devices.listForUser(userId);

    this.response.list(
      res,
      devices.map((listing) => this.presentDevice(listing)),
    );
  };

  /** Public device discovery for a peer; the peer never needs to authenticate. */
  listUserDevices: RequestHandler = async (req, res) => {
    this.requireAuth(req);
    const { userId } = userParamsSchema.parse(req.params);
    const devices = await this.devices.listForUser(userId);

    this.response.list(
      res,
      devices.map((listing) => this.presentDevice(listing)),
    );
  };

  rotate: RequestHandler = async (req, res) => {
    const { userId, deviceId } = this.requireAuth(req);
    const device = await this.devices.rotate(
      userId,
      deviceId,
      deviceRegistrationSchema.parse(req.body),
    );

    this.response.ok(res, this.presentDevice({ device, hasOneTimePreKeys: true }));
  };

  replenish: RequestHandler = async (req, res) => {
    const { userId, deviceId } = this.requireAuth(req);
    const body = prekeyReplenishmentSchema.parse(req.body);

    await this.devices.addOneTimePrekeys(userId, deviceId, body.oneTimePrekeys);

    this.response.noContent(res);
  };

  bundle: RequestHandler = async (req, res) => {
    this.requireAuth(req);
    const params = bundleParamsSchema.parse(req.params);
    const { device, oneTimePrekey } = await this.devices.bundle(params.userId, params.deviceId);

    this.response.ok(res, {
      deviceId: device.deviceId,
      userId: device.userId,
      signingPublicKey: device.signingPublicKey,
      identityPublicKey: device.identityPublicKey,
      identitySignature: device.identitySignature,
      signedPrekey: {
        id: device.signedPrekeyId,
        publicKey: device.signedPrekeyPublicKey,
        signature: device.signedPrekeySignature,
      },
      oneTimePrekey: {
        id: oneTimePrekey.prekeyId,
        publicKey: oneTimePrekey.publicKey,
      },
    });
  };

  private requireAuth(req: Request): { userId: string; deviceId: string } {
    if (!(req.auth && req.isAuthenticated())) {
      throw new UnauthorizedException();
    }

    return { userId: req.user.id, deviceId: req.auth.deviceId };
  }

  private presentDevice(listing: {
    device: {
      deviceId: string;
      userId: string;
      identityPublicKey: string;
      signingPublicKey: string;
      identitySignature: string;
      signedPrekeyId: number;
      rotatedAt: Date | null;
      createdAt: Date;
    };
    hasOneTimePreKeys: boolean;
  }) {
    const { device } = listing;

    return {
      deviceId: device.deviceId,
      userId: device.userId,
      identityPublicKey: device.identityPublicKey,
      signingPublicKey: device.signingPublicKey,
      identitySignature: device.identitySignature,
      signedPrekeyId: device.signedPrekeyId,
      hasOneTimePreKeys: listing.hasOneTimePreKeys,
      rotatedAt: device.rotatedAt?.toISOString() ?? null,
      createdAt: device.createdAt.toISOString(),
    };
  }
}
