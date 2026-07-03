/**
 * HOR-319 (Bug 2) — unit tests for the source-host self-heal helper.
 *
 * The host-lifecycle primitives (@horus/connectors) are mocked so we can drive each
 * branch of ensureSourceHost without spawning a real `horus-source` process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted so the mock object exists before the hoisted vi.mock factory runs.
const connectors = vi.hoisted(() => ({
  isHostHealthy: vi.fn(),
  sourceAvailable: vi.fn(),
  assertSourceVersionPinned: vi.fn(),
  isAnalyzed: vi.fn(),
  startHost: vi.fn(),
  waitForHost: vi.fn(),
  removeSpawnedHostRecord: vi.fn(),
  reconcileSpawnedHost: vi.fn(),
  fetchHostRepoPath: vi.fn(),
  readSourceHostUrl: vi.fn(),
  findFreePort: vi.fn(),
}));

vi.mock('@horus/connectors', () => connectors);

import {
  parseHostPort,
  ensureHostReasonHint,
  ensureSourceHost,
  verifyHostServesRepo,
  ensureOwnSourceHost,
  resolveSourceHostUrl,
} from './ensure-host.js';

const URL_8420 = 'http://127.0.0.1:8420';

beforeEach(() => {
  for (const fn of Object.values(connectors)) fn.mockReset();
  // Sensible defaults: backend present, version pinned, and repo analyzed unless a test
  // says otherwise.
  connectors.sourceAvailable.mockResolvedValue(true);
  connectors.assertSourceVersionPinned.mockResolvedValue(undefined);
  connectors.isAnalyzed.mockReturnValue(true);
  connectors.readSourceHostUrl.mockReturnValue(null);
  connectors.findFreePort.mockResolvedValue(8421);
});

afterEach(() => vi.restoreAllMocks());

describe('parseHostPort', () => {
  it('extracts the port', () => {
    expect(parseHostPort(URL_8420)).toBe(8420);
    expect(parseHostPort('http://127.0.0.1:9001')).toBe(9001);
  });
  it('returns null when there is no port or the URL is invalid', () => {
    expect(parseHostPort('http://example.com')).toBeNull();
    expect(parseHostPort('not a url')).toBeNull();
  });
});

describe('ensureHostReasonHint', () => {
  it('maps each reason to an actionable hint', () => {
    expect(ensureHostReasonHint('source-unavailable')).toMatch(/install\.sh/);
    expect(ensureHostReasonHint('version-mismatch')).toMatch(/pinned/);
    expect(ensureHostReasonHint('not-analyzed')).toMatch(/horus init/);
    expect(ensureHostReasonHint('bad-url')).toMatch(/valid URL/);
    expect(ensureHostReasonHint('no-free-port')).toMatch(/free localhost port/);
    expect(ensureHostReasonHint('unhealthy')).toMatch(/horus init/);
    expect(ensureHostReasonHint(undefined)).toMatch(/horus init/);
  });
});

describe('ensureSourceHost', () => {
  it('returns ok without restarting when the host is already healthy', async () => {
    connectors.isHostHealthy.mockResolvedValue(true);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: true, hostUrl: URL_8420 });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('reports source-unavailable when horus-source is not installed', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.sourceAvailable.mockResolvedValue(false);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: false, reason: 'source-unavailable' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('reports version-mismatch when the installed backend is drifted', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.assertSourceVersionPinned.mockRejectedValue(
      new Error('horus-source 1.4.0 is installed but Horus is pinned to 1.0.7'),
    );
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: false, reason: 'version-mismatch' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('reports not-analyzed for a repo that has never been indexed', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.isAnalyzed.mockReturnValue(false);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: false, reason: 'not-analyzed' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('reports bad-url when the configured host URL has no port', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    const res = await ensureSourceHost('/repo', 'http://example.com');
    expect(res).toEqual({ ok: false, reason: 'bad-url' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('restarts at the configured port and returns ok when it becomes healthy', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.waitForHost.mockResolvedValue(true);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: true, hostUrl: URL_8420 });
    expect(connectors.startHost).toHaveBeenCalledWith('/repo', 8420);
    expect(connectors.removeSpawnedHostRecord).not.toHaveBeenCalled();
    // Ownership record is reconciled to the backend's real server pid + actual port on success.
    expect(connectors.reconcileSpawnedHost).toHaveBeenCalledWith('/repo', 8420);
  });

  it('cleans up the ownership record when the restart never goes healthy', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.waitForHost.mockResolvedValue(false);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: false, reason: 'unhealthy' });
    expect(connectors.startHost).toHaveBeenCalledWith('/repo', 8420);
    expect(connectors.removeSpawnedHostRecord).toHaveBeenCalledWith('/repo');
    expect(connectors.reconcileSpawnedHost).not.toHaveBeenCalled();
  });
});

// HOR-421 — cross-repo contamination guard.
describe('verifyHostServesRepo', () => {
  it('matches when the host reports it serves THIS repo (path-normalized)', async () => {
    connectors.fetchHostRepoPath.mockResolvedValue('/repos/aiokafka/');
    expect(await verifyHostServesRepo(URL_8420, '/repos/aiokafka')).toBe('match');
  });

  it('flags a host serving a DIFFERENT repo as foreign', async () => {
    connectors.fetchHostRepoPath.mockResolvedValue('/repos/arq');
    expect(await verifyHostServesRepo(URL_8420, '/repos/aiokafka')).toBe('foreign');
  });

  it('returns unknown when the host cannot report its repo', async () => {
    connectors.fetchHostRepoPath.mockResolvedValue(null);
    expect(await verifyHostServesRepo(URL_8420, '/repos/aiokafka')).toBe('unknown');
  });
});

describe('ensureOwnSourceHost', () => {
  it('reuses the repo’s own recorded host when it is healthy and identity-matches', async () => {
    connectors.readSourceHostUrl.mockReturnValue('http://127.0.0.1:8421');
    connectors.isHostHealthy.mockResolvedValue(true);
    connectors.fetchHostRepoPath.mockResolvedValue('/repos/aiokafka');
    const res = await ensureOwnSourceHost('/repos/aiokafka');
    expect(res).toEqual({ ok: true, hostUrl: 'http://127.0.0.1:8421' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('spawns this repo’s own host on a FREE port and verifies its identity', async () => {
    connectors.readSourceHostUrl.mockReturnValue(null);
    connectors.findFreePort.mockResolvedValue(8423);
    connectors.waitForHost.mockResolvedValue(true);
    // The freshly-spawned host identifies as this repo.
    connectors.fetchHostRepoPath.mockResolvedValue('/repos/aiokafka');
    const res = await ensureOwnSourceHost('/repos/aiokafka');
    expect(res).toEqual({ ok: true, hostUrl: 'http://127.0.0.1:8423' });
    expect(connectors.startHost).toHaveBeenCalledWith('/repos/aiokafka', 8423);
    expect(connectors.reconcileSpawnedHost).toHaveBeenCalledWith('/repos/aiokafka', 8423);
  });

  it('does not spawn a second host on the recorded foreign URL — it falls through to a fresh port', async () => {
    // host.json points at :8420 but that host now serves a different repo.
    connectors.readSourceHostUrl.mockReturnValue(URL_8420);
    connectors.isHostHealthy.mockResolvedValue(true);
    connectors.findFreePort.mockResolvedValue(8424);
    connectors.waitForHost.mockResolvedValue(true);
    connectors.fetchHostRepoPath
      .mockResolvedValueOnce('/repos/arq') // recorded URL is foreign → reject reuse
      .mockResolvedValueOnce('/repos/aiokafka'); // spawned own host identifies correctly
    const res = await ensureOwnSourceHost('/repos/aiokafka');
    expect(res).toEqual({ ok: true, hostUrl: 'http://127.0.0.1:8424' });
    expect(connectors.startHost).toHaveBeenCalledWith('/repos/aiokafka', 8424);
  });

  it('reports not-analyzed before spawning when the repo was never indexed', async () => {
    connectors.readSourceHostUrl.mockReturnValue(null);
    connectors.isAnalyzed.mockReturnValue(false);
    const res = await ensureOwnSourceHost('/repos/aiokafka');
    expect(res).toEqual({ ok: false, reason: 'not-analyzed' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });
});

describe('resolveSourceHostUrl — foreign-host contamination guard', () => {
  it('uses the configured host when it is healthy and serves THIS repo', async () => {
    connectors.isHostHealthy.mockResolvedValue(true);
    connectors.fetchHostRepoPath.mockResolvedValue('/repos/aiokafka');
    const res = await resolveSourceHostUrl('/repos/aiokafka', URL_8420);
    expect(res).toEqual({ ok: true, hostUrl: URL_8420 });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('REJECTS a foreign host on :8420 and starts this repo’s own host on a free port', async () => {
    // The configured :8420 is healthy but serves a DIFFERENT repo (arq), and this repo has
    // no own host recorded → spawn a fresh one on a free port and ground on THAT.
    connectors.isHostHealthy.mockImplementation(async (url: string) => url === URL_8420);
    connectors.readSourceHostUrl.mockReturnValue(null);
    connectors.findFreePort.mockResolvedValue(8425);
    connectors.waitForHost.mockResolvedValue(true);
    connectors.fetchHostRepoPath
      .mockResolvedValueOnce('/repos/arq') // :8420 is foreign
      .mockResolvedValueOnce('/repos/aiokafka'); // spawned own host
    const res = await resolveSourceHostUrl('/repos/aiokafka', URL_8420);
    expect(res).toEqual({ ok: true, hostUrl: 'http://127.0.0.1:8425' });
    expect(res.hostUrl).not.toBe(URL_8420);
    expect(connectors.startHost).toHaveBeenCalledWith('/repos/aiokafka', 8425);
  });

  it('refuses to ground on a foreign host when no own host can be started (degrade)', async () => {
    connectors.isHostHealthy.mockImplementation(async (url: string) => url === URL_8420);
    connectors.readSourceHostUrl.mockReturnValue(null);
    connectors.fetchHostRepoPath.mockResolvedValue('/repos/arq'); // foreign, forever
    connectors.isAnalyzed.mockReturnValue(false); // can't spawn own
    const res = await resolveSourceHostUrl('/repos/aiokafka', URL_8420);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not-analyzed');
    // Critically: we never returned the foreign URL.
    expect(res.hostUrl).toBeUndefined();
  });
});
