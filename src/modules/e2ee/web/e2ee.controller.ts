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

    this.response.created(res, this.presentDevice(device));
  };

  listMine: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const devices = await this.devices.listForUser(userId);

    this.response.list(
      res,
      devices.map((device) => this.presentDevice(device)),
    );
  };

  rotate: RequestHandler = async (req, res) => {
    const { userId, deviceId } = this.requireAuth(req);
    const device = await this.devices.rotate(
      userId,
      deviceId,
      deviceRegistrationSchema.parse(req.body),
    );

    this.response.ok(res, this.presentDevice(device));
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

  private presentDevice(device: {
    deviceId: string;
    identityPublicKey: string;
    signingPublicKey: string;
    signedPrekeyId: number;
    rotatedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      deviceId: device.deviceId,
      identityPublicKey: device.identityPublicKey,
      signingPublicKey: device.signingPublicKey,
      signedPrekeyId: device.signedPrekeyId,
      rotatedAt: device.rotatedAt?.toISOString() ?? null,
      createdAt: device.createdAt.toISOString(),
    };
  }
}
