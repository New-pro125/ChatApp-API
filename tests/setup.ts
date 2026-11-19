// Load .env once before tests mutate process.env; otherwise a later dynamic
// import of app.config rehydrates deleted variables such as MEDIA_BUCKET.
import 'dotenv/config';
import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.MFA_ENCRYPTION_KEY =
  process.env.MFA_ENCRYPTION_KEY || 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
process.env.MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'messenger-media';
process.env.MEDIA_ACCESS_KEY_ID = process.env.MEDIA_ACCESS_KEY_ID || 'minioadmin';
process.env.MEDIA_SECRET_ACCESS_KEY = process.env.MEDIA_SECRET_ACCESS_KEY || 'minioadmin';
process.env.MEDIA_ENDPOINT = process.env.MEDIA_ENDPOINT || 'http://localhost:9000';
