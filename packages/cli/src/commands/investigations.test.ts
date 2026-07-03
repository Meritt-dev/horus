/**
 * Tests for `horus investigations` — the local audit store must be the primary
 * list (its ids are what replay/ask/postmortem accept). Regression for the
 * cloud-linked bug where the cloud list REPLACED the local one, printing only
 * cloud ids that `horus replay` could not resolve.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const seams = vi.hoisted(() => ({
  openDb: vi.fn(),
  listInvestigations: vi.fn(),
  readCloudConfig: vi.fn(),
  isCloudActive: vi.fn(),
  authedClient: vi.fn(),
  listCloudInvestigations: vi.fn(),
  sqlEnd: vi.fn(async () => {}),
}));

vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  return { ...actual, openDb: seams.openDb, listInvestigations: seams.listInvestigations };
});
vi.mock('../lib/db-url.js', () => ({ resolveDbUrl: vi.fn(async () => 'postgres://local') }));
vi.mock('../lib/cloud/context-store.js', () => ({
  readCloudConfig: seams.readCloudConfig,
  isCloudActive: seams.isCloudActive,
}));
vi.mock('../lib/cloud/session.js', () => ({
  authedClient: seams.authedClient,
  repoRootOrCwd: vi.fn(() => '/tmp/repo'),
}));
vi.mock('../lib/cloud/investigation-sync.js', () => ({
  listCloudInvestigations: seams.listCloudInvestigations,
}));

import { runInvestigations } from './investigations.js';

const LOCAL_ROW = {
  id: 'local-1111',
  createdAt: new Date('2026-07-01T10:00:00Z'),
  title: 'orders stuck',
};

/** A cloud row that ORIGINATED from LOCAL_ROW (idempotencyKey carries the local id). */
const CLOUD_ROW_SYNCED = {
  id: 'cloud-aaaa',
  idempotencyKey: 'local-1111:investigation',
  createdAt: '2026-07-01T10:00:05Z',
  title: 'orders stuck',
};

/** A teammate's cloud investigation with no local counterpart. */
const CLOUD_ROW_FOREIGN = {
  id: 'cloud-bbbb',
  idempotencyKey: 'other-2222:investigation',
  createdAt: '2026-07-01T11:00:00Z',
  title: 'checkout latency',
};

let logs: string[];
let errs: string[];

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  seams.openDb.mockResolvedValue({ db: {}, sql: { end: seams.sqlEnd } });
  seams.listInvestigations.mockResolvedValue([LOCAL_ROW]);
  seams.readCloudConfig.mockReturnValue(null);
  seams.isCloudActive.mockReturnValue(false);
  seams.authedClient.mockReturnValue({ client: {} });
  seams.listCloudInvestigations.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('runInvestigations (not cloud-linked)', () => {
  it('lists local ids with the replay hint', async () => {
    const code = await runInvestigations({});
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('local-1111');
    expect(out).toContain('horus replay <id>');
  });

  it('prints the empty-state hint when there are none', async () => {
    seams.listInvestigations.mockResolvedValue([]);
    const code = await runInvestigations({});
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('No investigations yet');
  });

  it('fails loudly when the local store is unreachable', async () => {
    seams.openDb.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const code = await runInvestigations({});
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('ECONNREFUSED');
  });
});

describe('runInvestigations (cloud-linked)', () => {
  beforeEach(() => {
    seams.readCloudConfig.mockReturnValue({ project: { id: 'p1' } });
    seams.isCloudActive.mockReturnValue(true);
  });

  it('REGRESSION: local (replayable) ids lead; synced cloud twins are deduped', async () => {
    seams.listCloudInvestigations.mockResolvedValue([CLOUD_ROW_SYNCED, CLOUD_ROW_FOREIGN]);
    const code = await runInvestigations({});
    expect(code).toBe(0);
    const out = logs.join('\n');
    // The local id is printed (replay works with it)…
    expect(out).toContain('local-1111');
    // …its cloud twin is NOT listed as a separate row…
    expect(out).not.toContain('cloud-aaaa');
    // …and the teammate's cloud-only row is appended, clearly marked.
    expect(out).toContain('cloud-bbbb');
    expect(out).toContain('[cloud]');
    expect(out).toContain('not locally replayable');
  });

  it('still lists local ids when not logged in (with a login hint)', async () => {
    seams.authedClient.mockReturnValue(null);
    const code = await runInvestigations({});
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('local-1111');
    expect(out).toContain('horus login');
  });

  it('degrades to the local list when the cloud call fails', async () => {
    seams.listCloudInvestigations.mockRejectedValue(new Error('cloud 502'));
    const code = await runInvestigations({});
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('local-1111');
    expect(out).toContain('cloud list unavailable');
  });

  it('cloud-linked with a dead local store still shows cloud rows and explains replay needs the store', async () => {
    seams.openDb.mockRejectedValue(new Error('connect ECONNREFUSED'));
    seams.listCloudInvestigations.mockResolvedValue([CLOUD_ROW_FOREIGN]);
    const code = await runInvestigations({});
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('cloud-bbbb');
    expect(out).toContain('local audit store unavailable');
  });
});
