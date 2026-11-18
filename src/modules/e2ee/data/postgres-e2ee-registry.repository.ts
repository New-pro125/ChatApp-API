import { asc, eq, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PostgresErrorInspector } from '@/core/database/database.error-inspector.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { e2eeDevices, e2eePrekeys } from '@/core/database/schema/index.js';
import { E2eeDeviceConflictException } from '@/core/errors/domain.error.js';
import { PersistenceException, UniqueConstraintException } from '@/core/errors/repository.error.js';
import { E2eeMapper } from '@/modules/e2ee/data/e2ee.mapper.js';
import type { E2eeDeviceRecord } from '@/modules/e2ee/logic/entities/e2ee-device-record.js';
import type {
  CreateE2eeDeviceInput,
  E2eeBundleRecord,
  E2eeRegistryRepository,
} from '@/modules/e2ee/logic/ports/e2ee-registry.repository.js';

const PREKEY_PRIMARY_KEY = 'e2ee_prekeys_pkey';

/**
 * PostgreSQL registry for public E2EE device key material.
 *
 * Device rows are locked (`FOR UPDATE`) before their prekeys are touched so
 * bundle consumption, rotation, and replenishment serialize per device. All
 * unique violations are classified by constraint name: prekey id collisions
 * become `UniqueConstraintException` for the service to translate, while
 * device-level collisions stay `E2eeDeviceConflictException`.
 */
@injectable()
export class PostgresE2eeRegistryRepository implements E2eeRegistryRepository {
  private readonly inspector = new PostgresErrorInspector();
  private readonly mapper = new E2eeMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async create(input: CreateE2eeDeviceInput): Promise<E2eeDeviceRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(e2eeDevices)
          .values({
            deviceId: input.deviceId,
            userId: input.userId,
            signingPublicKey: input.signingPublicKey,
            identityPublicKey: input.identityPublicKey,
            identitySignature: input.identitySignature,
            signedPrekeyId: input.signedPrekeyId,
            signedPrekeyPublicKey: input.signedPrekeyPublicKey,
            signedPrekeySignature: input.signedPrekeySignature,
          })
          .returning();

        if (!row) {
          throw new PersistenceException('Device insert returned no row');
        }

        await tx.insert(e2eePrekeys).values(
          input.oneTimePrekeys.map((key) => ({
            deviceId: input.deviceId,
            prekeyId: key.id,
            publicKey: key.publicKey,
          })),
        );

        return this.mapper.device(row);
      });
    } catch (error) {
      if (error instanceof E2eeDeviceConflictException || error instanceof PersistenceException) {
        throw error;
      }

      if (this.inspector.isUniqueViolation(error)) {
        throw this.uniqueViolation(error);
      }

      throw new PersistenceException('Failed to register E2EE device', { cause: error });
    }
  }

  async findByUserAndDevice(userId: string, deviceId: string): Promise<E2eeDeviceRecord | null> {
    const [row] = await this.db
      .select()
      .from(e2eeDevices)
      .where(sql`${e2eeDevices.userId} = ${userId} and ${e2eeDevices.deviceId} = ${deviceId}`)
      .limit(1);

    return row ? this.mapper.device(row) : null;
  }

  async findByDeviceId(deviceId: string): Promise<E2eeDeviceRecord | null> {
    const [row] = await this.db
      .select()
      .from(e2eeDevices)
      .where(eq(e2eeDevices.deviceId, deviceId))
      .limit(1);

    return row ? this.mapper.device(row) : null;
  }

  async listByUser(userId: string): Promise<E2eeDeviceRecord[]> {
    const rows = await this.db
      .select()
      .from(e2eeDevices)
      .where(eq(e2eeDevices.userId, userId))
      .orderBy(asc(e2eeDevices.createdAt));

    return rows.map((row) => this.mapper.device(row));
  }

  async replace(input: CreateE2eeDeviceInput): Promise<E2eeDeviceRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(e2eeDevices)
          .set({
            signingPublicKey: input.signingPublicKey,
            identityPublicKey: input.identityPublicKey,
            identitySignature: input.identitySignature,
            signedPrekeyId: input.signedPrekeyId,
            signedPrekeyPublicKey: input.signedPrekeyPublicKey,
            signedPrekeySignature: input.signedPrekeySignature,
            updatedAt: new Date(),
            rotatedAt: new Date(),
          })
          .where(
            sql`${e2eeDevices.userId} = ${input.userId} and ${e2eeDevices.deviceId} = ${input.deviceId}`,
          )
          .returning();

        if (!row) {
          throw new E2eeDeviceConflictException('Device must be registered before rotation');
        }

        await tx.delete(e2eePrekeys).where(eq(e2eePrekeys.deviceId, input.deviceId));
        await tx.insert(e2eePrekeys).values(
          input.oneTimePrekeys.map((key) => ({
            deviceId: input.deviceId,
            prekeyId: key.id,
            publicKey: key.publicKey,
          })),
        );

        return this.mapper.device(row);
      });
    } catch (error) {
      if (error instanceof E2eeDeviceConflictException || error instanceof PersistenceException) {
        throw error;
      }

      if (this.inspector.isUniqueViolation(error)) {
        throw this.uniqueViolation(error);
      }

      throw new PersistenceException('Failed to rotate E2EE device', { cause: error });
    }
  }

  async addOneTimePrekeys(
    deviceId: string,
    keys: ReadonlyArray<{ readonly id: number; readonly publicKey: string }>,
  ): Promise<void> {
    try {
      await this.db
        .insert(e2eePrekeys)
        .values(keys.map((key) => ({ deviceId, prekeyId: key.id, publicKey: key.publicKey })));
    } catch (error) {
      if (this.inspector.isUniqueViolation(error)) {
        throw new UniqueConstraintException('One-time prekey id is already in use', {
          cause: error,
        });
      }

      throw new PersistenceException('Failed to add one-time E2EE prekeys', { cause: error });
    }
  }

  consumeOneTimePrekey(deviceId: string): Promise<E2eePrekeyRecord | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(e2eePrekeys)
        .where(eq(e2eePrekeys.deviceId, deviceId))
        .orderBy(asc(e2eePrekeys.prekeyId))
        .limit(1)
        .for('update', { skipLocked: true });

      if (!row) {
        return null;
      }

      await tx
        .delete(e2eePrekeys)
        .where(
          sql`${e2eePrekeys.deviceId} = ${deviceId} and ${e2eePrekeys.prekeyId} = ${row.prekeyId}`,
        );

      return this.mapper.prekey(row);
    });
  }

  async countOneTimePrekeys(deviceId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(e2eePrekeys)
      .where(eq(e2eePrekeys.deviceId, deviceId));

    return row?.count ?? 0;
  }

  /** Prekey ids collide on the composite primary key; devices on unique rows. */
  private uniqueViolation(error: unknown): Error {
    const constraint = this.inspector.constraintName(error);

    if (constraint === PREKEY_PRIMARY_KEY) {
      return new UniqueConstraintException(PREKEY_PRIMARY_KEY, { cause: error });
    }

    return new E2eeDeviceConflictException('This device is already registered', {
      cause: error,
    });
  }
}
