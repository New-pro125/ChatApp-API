export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN mfa_secret_ciphertext text,
      ADD COLUMN mfa_enrollment_started_at timestamptz,
      ADD COLUMN mfa_enrolled_at timestamptz,
      ADD COLUMN mfa_last_totp_step bigint;

    ALTER TABLE users
      ADD CONSTRAINT users_mfa_enrollment_consistency
      CHECK (
        NOT mfa_enabled
        OR (mfa_secret_ciphertext IS NOT NULL AND mfa_enrolled_at IS NOT NULL)
      );

    ALTER TABLE users
      ADD CONSTRAINT users_mfa_last_totp_step_nonnegative
      CHECK (mfa_last_totp_step IS NULL OR mfa_last_totp_step >= 0);

    CREATE TABLE mfa_challenges (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      token_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      consumed_at timestamptz,
      requested_ip text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mfa_challenges_attempts_nonnegative CHECK (attempts >= 0)
    );

    CREATE UNIQUE INDEX mfa_challenges_token_hash_unique
      ON mfa_challenges (token_hash);

    CREATE INDEX mfa_challenges_user_id_created_at_index
      ON mfa_challenges (user_id, created_at DESC);

    CREATE TABLE mfa_recovery_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      code_hash text NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX mfa_recovery_codes_user_id_code_hash_unique
      ON mfa_recovery_codes (user_id, code_hash);

    CREATE INDEX mfa_recovery_codes_user_id_used_at_index
      ON mfa_recovery_codes (user_id, used_at);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS mfa_recovery_codes;
    DROP TABLE IF EXISTS mfa_challenges;

    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_mfa_last_totp_step_nonnegative,
      DROP CONSTRAINT IF EXISTS users_mfa_enrollment_consistency,
      DROP COLUMN IF EXISTS mfa_last_totp_step,
      DROP COLUMN IF EXISTS mfa_enrolled_at,
      DROP COLUMN IF EXISTS mfa_enrollment_started_at,
      DROP COLUMN IF EXISTS mfa_secret_ciphertext,
      DROP COLUMN IF EXISTS mfa_enabled;
  `);
};
