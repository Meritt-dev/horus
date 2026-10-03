/** CLI delegates to the durable sync path; replication/privacy are exercised in memory-sync.test.ts. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), sync: vi.fn(), query: vi.fn() }));
vi.mock('@horus/db', async original => ({ ...await original<typeof import('@horus/db')>(), openDb: mocks.open }));
vi.mock('@horus/engine', async original => ({ ...await original<typeof import('@horus/engine')>(), createLocalMemoryStore: () => ({ query: mocks.query }) }));
vi.mock('../lib/cloud/memory-sync.js', () => ({ syncLinkedMemory: mocks.sync, memorySyncContext: () => null }));
import { runMemorySync } from './memory.js';
import { writeAuth, clearAuth } from '../lib/cloud/auth-store.js';
import { writeCloudConfig, clearCloudConfig } from '../lib/cloud/context-store.js';
let dir: string; let config: string;
const state = { state: 'Synced', eligible: 3, synced: 3, pending: 0, excluded: 1, failed: 0 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-command-')); process.env.HORUS_HOME = dir;
  config = join(dir, 'horus.config.js');
  writeFileSync(config, `export default { projects: [{ name: 'api', repositories: [{ name: 'api', path: '${dir}' }], environments: [{ name: 'production', connectors: {} }] }] };`);
  writeAuth({ apiBaseUrl: 'https://api.test', token: 'test-token', account: { userId: 'owner', email: 'test@example.com' } });
  writeCloudConfig(dir, { context: 'cloud', organization: { id: 'org', slug: 'org' }, workspace: { id: 'ws', slug: 'ws' }, project: { id: 'project', slug: 'project' } });
  mocks.open.mockResolvedValue({ db: { test: true }, sql: { end: mocks.close } });
  mocks.sync.mockResolvedValue(state); mocks.query.mockResolvedValue([{ id: 'm' }]);
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.HORUS_HOME; vi.restoreAllMocks(); vi.clearAllMocks(); });
it('uses automatic replication without recurring confirmation and emits one status JSON', async () => {
  expect(await runMemorySync({ config, cwd: dir, repo: 'api', json: true })).toBe(0);
  expect(mocks.sync).toHaveBeenCalledWith({ test: true }, dir, 'api', { resolve: undefined, choice: undefined, restore: undefined });
  expect(console.log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(state);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('reports pending failures and closes storage', async () => {
  mocks.sync.mockResolvedValue({ ...state, state: 'Pending sync', pending: 1, failed: 1, error: 'offline' });
  expect(await runMemorySync({ config, cwd: dir, repo: 'api', json: true })).toBe(1);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('previews locally including tombstones without making sync calls', async () => {
  expect(await runMemorySync({ config, cwd: dir, repo: 'api', dryRun: true })).toBe(0);
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls[0]![0].status).toContain('forgotten');
  expect(mocks.query.mock.calls[0]![0].origin).toBe('local');
});
it('requires a linked project and authenticated account', async () => {
  clearAuth(); expect(await runMemorySync({ config, cwd: dir, repo: 'api' })).toBe(1);
  clearCloudConfig(dir); expect(await runMemorySync({ config, cwd: dir, repo: 'api' })).toBe(1);
  expect(mocks.sync).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
});
