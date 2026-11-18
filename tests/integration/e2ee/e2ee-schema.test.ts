import { describe, expect, it } from 'vitest';
import { TestApp } from '../../helpers/test-app.js';

describe('E2EE schema', () => {
  it('stores public keys, prekeys, and ciphertext without plaintext columns', async () => {
    const app = await TestApp.create();

    try {
      const deviceColumns = await app.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'e2ee_devices'`,
      );
      expect(deviceColumns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining([
          'device_id',
          'user_id',
          'signing_public_key',
          'identity_public_key',
          'identity_signature',
          'signed_prekey_id',
          'signed_prekey_public_key',
          'signed_prekey_signature',
          'created_at',
          'updated_at',
          'rotated_at',
        ]),
      );
      expect(deviceColumns.rows.map((row) => row.column_name)).not.toContain('private_key');

      const prekeyColumns = await app.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'e2ee_prekeys'`,
      );
      expect(prekeyColumns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining(['device_id', 'prekey_id', 'public_key', 'created_at']),
      );

      const messageColumns = await app.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'messages'`,
      );
      expect(messageColumns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining([
          'ciphertext',
          'nonce',
          'ephemeral_public_key',
          'sender_device_id',
          'recipient_device_id',
        ]),
      );

      const chatType = await app.pool.query<{ condef: string }>(
        `select pg_get_constraintdef(oid) as condef from pg_constraint where conname = 'chats_type_check'`,
      );
      expect(chatType.rows[0]?.condef).toContain("'secret'");

      const partitions = await app.pool.query<{ count: string }>(
        `select count(*)::text as count from pg_inherits where inhparent = 'messages'::regclass`,
      );
      expect(partitions.rows[0]?.count).toBe('16');
    } finally {
      await app.close();
    }
  });
});
