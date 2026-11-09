export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE password_reset_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      code_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      consumed_at timestamptz,
      reset_token_hash text,
      token_expires_at timestamptz,
      token_used_at timestamptz,
      requested_ip text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT password_reset_codes_attempts_nonnegative
        CHECK (attempts >= 0)
    );

    CREATE INDEX password_reset_codes_user_id_created_at_index
      ON password_reset_codes (user_id, created_at DESC);

    CREATE UNIQUE INDEX password_reset_codes_reset_token_hash_unique
      ON password_reset_codes (reset_token_hash)
      WHERE reset_token_hash IS NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS password_reset_codes;`);
};
