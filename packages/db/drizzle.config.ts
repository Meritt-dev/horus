import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  // pglite (the sole local persistence tier) is Postgres-wire-compatible, so migrations
  // are authored with the postgresql dialect. `drizzle-kit generate` reads the schema and
  // emits SQL without dialing a database; the url below is only consulted by connect-time
  // commands (push/studio) and defaults to an inert placeholder since there is no
  // self-run Postgres — set DATABASE_URL to point those at a real instance if needed.
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://embedded',
  },
  // No pgvector / extensions in v0.
  strict: true,
  verbose: true,
});
