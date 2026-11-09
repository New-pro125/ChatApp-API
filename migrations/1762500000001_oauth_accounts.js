export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE oauth_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      provider text NOT NULL,
      provider_account_id text NOT NULL,
      email text,
      display_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT oauth_accounts_provider_account_unique
        UNIQUE (provider, provider_account_id)
    );

    CREATE INDEX oauth_accounts_user_id_index ON oauth_accounts (user_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS oauth_accounts;`);
};
