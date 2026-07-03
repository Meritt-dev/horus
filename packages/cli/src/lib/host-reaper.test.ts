import { describe, it, expect } from 'vitest';
import {
  parseSourceHosts,
  selectOrphans,
  isLiveRegisteredHost,
  countDistinctLiveHosts,
  type RegisteredHostState,
} from './host-reaper.js';

describe('parseSourceHosts', () => {
  it('extracts pid + port from horus-source host lines (path-prefixed and --port=)', () => {
    const ps = [
      '  60530 /Users/x/.local/share/uv/tools/horus-source/bin/python3 /Users/x/.local/bin/horus-source host --port 8420',
      '81064 /usr/bin/python3 horus-source host --port=8421',
    ].join('\n');
    expect(parseSourceHosts(ps)).toEqual([
      { pid: 60530, port: 8420 },
      { pid: 81064, port: 8421 },
    ]);
  });

  it('ignores unrelated processes and blank lines', () => {
    const ps = [
      '12345 /usr/bin/node some-other-app --port 9999',
      '999 grep horus-source',
      '',
      '  ',
      '777 /bin/horus-source serve --foo', // not "host --port"
    ].join('\n');
    expect(parseSourceHosts(ps)).toEqual([]);
  });

  it('captures the full port number (no 8420-in-84200 false match)', () => {
    expect(parseSourceHosts('5 horus-source host --port 84200')).toEqual([{ pid: 5, port: 84200 }]);
  });
});

describe('selectOrphans', () => {
  const running = [
    { pid: 1, port: 8420 },
    { pid: 2, port: 8420 }, // duplicate on a claimed port — still an orphan by pid
    { pid: 3, port: 8421 },
  ];

  it('flags hosts whose pid is not claimed by any registered repo', () => {
    expect(selectOrphans(running, new Set([1, 3]))).toEqual([{ pid: 2, port: 8420 }]);
  });

  it('treats everything as orphan when nothing is claimed', () => {
    expect(selectOrphans(running, new Set())).toEqual(running);
  });

  it('returns none when every pid is claimed', () => {
    expect(selectOrphans(running, new Set([1, 2, 3]))).toEqual([]);
  });
});

// HOR-389 — `horus hosts` count must reflect LIVE processes, not registry rows.
const host = (over: Partial<RegisteredHostState>): RegisteredHostState => ({
  name: 'repo',
  hostUrl: 'http://127.0.0.1:8420',
  pid: 100,
  port: 8420,
  healthy: false,
  pidAlive: null,
  ...over,
});

describe('isLiveRegisteredHost', () => {
  it('is live when the health check passes', () => {
    expect(isLiveRegisteredHost(host({ healthy: true }))).toBe(true);
  });

  it('is NOT live when health fails and the recorded pid is dead', () => {
    expect(isLiveRegisteredHost(host({ healthy: false, pidAlive: false }))).toBe(false);
  });

  it('is NOT live for a stale entry with a URL but no pid info', () => {
    expect(isLiveRegisteredHost(host({ healthy: false, pid: null, pidAlive: null }))).toBe(false);
  });

  it('falls back to pid-liveness only when no host URL is recorded', () => {
    expect(isLiveRegisteredHost(host({ hostUrl: null, healthy: false, pidAlive: true }))).toBe(true);
    // A recorded URL that failed its health check is dead even if some pid is alive.
    expect(isLiveRegisteredHost(host({ healthy: false, pidAlive: true }))).toBe(false);
  });
});

describe('countDistinctLiveHosts', () => {
  it('counts only live entries — stale/dead registry rows are excluded', () => {
    const rows = [
      host({ name: 'a', pid: 1, port: 8420, healthy: true }),
      host({ name: 'b', pid: 2, port: 8421, healthy: false, pidAlive: false }), // dead
      host({ name: 'c', pid: 3, port: 8422, healthy: false, pidAlive: null }), // stale
    ];
    expect(countDistinctLiveHosts(rows)).toBe(1);
  });

  it('dedupes many registry entries that resolve to ONE running process (the 40→1 bug)', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      host({ name: `repo-${i}`, pid: 999, port: 8420, healthy: true }),
    );
    expect(countDistinctLiveHosts(rows)).toBe(1);
  });

  it('dedupes by port when pid is unknown', () => {
    const rows = [
      host({ name: 'a', pid: null, port: 8420, healthy: true }),
      host({ name: 'b', pid: null, port: 8420, healthy: true }),
      host({ name: 'c', pid: null, port: 8421, healthy: true }),
    ];
    expect(countDistinctLiveHosts(rows)).toBe(2);
  });

  it('counts distinct live processes across different pids', () => {
    const rows = [
      host({ name: 'a', pid: 1, port: 8420, healthy: true }),
      host({ name: 'b', pid: 2, port: 8421, healthy: true }),
      host({ name: 'c', pid: 3, port: 8422, healthy: false, pidAlive: false }),
    ];
    expect(countDistinctLiveHosts(rows)).toBe(2);
  });

  it('is zero when the registry is full of stale entries and nothing is live', () => {
    const rows = [
      host({ name: 'a', healthy: false, pidAlive: false }),
      host({ name: 'b', healthy: false, pidAlive: null }),
      host({ name: 'c', hostUrl: null, healthy: false, pidAlive: false }),
    ];
    expect(countDistinctLiveHosts(rows)).toBe(0);
  });
});


describe('host identity (dogfood finding 5 — foreign host on the shared port)', () => {
  const base = { name: 'p', hostUrl: 'http://127.0.0.1:8420', pid: 1, port: 8420, pidAlive: true };

  it('a healthy port serving ANOTHER repo is NOT live', () => {
    expect(isLiveRegisteredHost({ ...base, healthy: true, servesRepo: false })).toBe(false);
  });

  it('a healthy port serving THIS repo is live', () => {
    expect(isLiveRegisteredHost({ ...base, healthy: true, servesRepo: true })).toBe(true);
  });

  it('identity-unknown (old backend / no report) keeps back-compat liveness', () => {
    expect(isLiveRegisteredHost({ ...base, healthy: true, servesRepo: null })).toBe(true);
    expect(isLiveRegisteredHost({ ...base, healthy: true })).toBe(true);
  });
});
