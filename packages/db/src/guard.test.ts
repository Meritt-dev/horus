import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cloudDatabaseUrlReason,
  looksLikeCloudDatabaseUrl,
  assertLocalDatabaseUrl,
  CloudDatabaseUrlError,
} from './guard.js';
import { importFromPostgres, type HorusDb } from './client.js';

const LOCAL = 'postgresql://horus:horus@localhost:5433/horus';
const CLOUD_PORT = 'postgresql://horus:pw@localhost:5434/horus';
const CLOUD_DBNAME = 'postgresql://horus:pw@localhost:5433/horus_cloud';
const CLOUD_FULL = 'postgres://horus:horus_dev_password@localhost:5434/horus_cloud';

describe('cloud database guard (HOR-298)', () => {
  const savedEnv = process.env['HORUS_CLOUD_DATABASE_URL'];

  beforeEach(() => {
    delete process.env['HORUS_CLOUD_DATABASE_URL'];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['HORUS_CLOUD_DATABASE_URL'];
    else process.env['HORUS_CLOUD_DATABASE_URL'] = savedEnv;
  });

  it('treats the local CLI database URL as local', () => {
    expect(cloudDatabaseUrlReason(LOCAL)).toBeNull();
    expect(looksLikeCloudDatabaseUrl(LOCAL)).toBe(false);
    expect(() => assertLocalDatabaseUrl(LOCAL)).not.toThrow();
  });

  it('flags the Cloud port (5434)', () => {
    expect(cloudDatabaseUrlReason(CLOUD_PORT)).toMatch(/5434/);
    expect(() => assertLocalDatabaseUrl(CLOUD_PORT)).toThrow(CloudDatabaseUrlError);
  });

  it('flags the Cloud database name (horus_cloud)', () => {
    expect(cloudDatabaseUrlReason(CLOUD_DBNAME)).toMatch(/horus_cloud/);
    expect(() => assertLocalDatabaseUrl(CLOUD_DBNAME)).toThrow(CloudDatabaseUrlError);
  });

  it('flags the full default Cloud URL', () => {
    expect(looksLikeCloudDatabaseUrl(CLOUD_FULL)).toBe(true);
    expect(() => assertLocalDatabaseUrl(CLOUD_FULL)).toThrow(/Cloud/);
  });

  it('flags any URL equal to HORUS_CLOUD_DATABASE_URL, even a remote one', () => {
    // A remote cloud URL with no 5434 / horus_cloud markers is still caught by
    // the exact-match-to-env branch.
    const remote = 'postgres://u:p@cloud.example.com:5432/teamdb';
    expect(cloudDatabaseUrlReason(remote)).toBeNull(); // not cloud on its own
    process.env['HORUS_CLOUD_DATABASE_URL'] = remote;
    expect(cloudDatabaseUrlReason(remote)).toMatch(/HORUS_CLOUD_DATABASE_URL/);
    expect(() => assertLocalDatabaseUrl(remote)).toThrow(CloudDatabaseUrlError);
    // ...but the local URL is still fine even with the env set.
    expect(() => assertLocalDatabaseUrl(LOCAL)).not.toThrow();
  });

  it('ignores empty/blank URLs (handled by normal connection flow)', () => {
    expect(cloudDatabaseUrlReason('')).toBeNull();
  });

  it('importFromPostgres refuses a Cloud database as its --from source', async () => {
    // The guard fires before any connection is opened, so no live Postgres is needed.
    const db = {} as HorusDb;
    await expect(importFromPostgres(CLOUD_FULL, db)).rejects.toBeInstanceOf(CloudDatabaseUrlError);
    await expect(importFromPostgres(CLOUD_PORT, db)).rejects.toBeInstanceOf(CloudDatabaseUrlError);
  });
});
