export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ALTER COLUMN password_hash DROP NOT NULL,
      ADD COLUMN email_verified_at timestamptz,
      ADD COLUMN failed_login_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN locked_until timestamptz,
      ADD COLUMN last_failed_login_at timestamptz,
      ADD COLUMN session_version integer NOT NULL DEFAULT 1;

    ALTER TABLE users
      ADD CONSTRAINT users_failed_login_attempts_nonnegative
      CHECK (failed_login_attempts >= 0);

    ALTER TABLE users
      ADD CONSTRAINT users_session_version_positive
      CHECK (session_version > 0);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_session_version_positive,
      DROP CONSTRAINT IF EXISTS users_failed_login_attempts_nonnegative,
      DROP COLUMN IF EXISTS session_version,
      DROP COLUMN IF EXISTS last_failed_login_at,
      DROP COLUMN IF EXISTS locked_until,
      DROP COLUMN IF EXISTS failed_login_attempts,
      DROP COLUMN IF EXISTS email_verified_at;

    ALTER TABLE users
      ALTER COLUMN password_hash SET NOT NULL;
  `);
};
