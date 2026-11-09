import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL is required to reset the database');
}

const client = new pg.Client({ connectionString: url });

await client.connect();
await client.query('DROP SCHEMA IF EXISTS public CASCADE');
await client.query('CREATE SCHEMA public');
await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
await client.end();

console.log('Database schemas dropped. Run `npm run db:migrate` to rebuild.');
