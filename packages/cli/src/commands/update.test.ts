import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { parseVersion, isNewer, runUpdate } from './update.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it('parses semver strings', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v0.1.17')).toEqual([0, 1, 17]);
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0]);
  });

  it('throws on unparseable input', () => {
    expect(() => parseVersion('not-a-version')).toThrow();
  });
});

describe('isNewer', () => {
  it('detects a newer patch', () => {
    expect(isNewer('0.1.17', '0.1.16')).toBe(true);
  });

  it('detects a newer minor', () => {
    expect(isNewer('0.2.0', '0.1.99')).toBe(true);
  });

  it('detects a newer major', () => {
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
  });

  it('returns false when same', () => {
    expect(isNewer('0.1.16', '0.1.16')).toBe(false);
  });

  it('returns false when older', () => {
    expect(isNewer('0.1.15', '0.1.16')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capture(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

function makeRelease(version: string, includeChecksum = false) {
  const tag = `v${version}`;
  const assetName = `horus-${tag}`;
  const assets: Array<{ name: string; browser_download_url: string }> = [
    { name: assetName, browser_download_url: `https://example.com/${assetName}` },
  ];
  if (includeChecksum) {
    assets.push({
      name: `${assetName}.sha256`,
      browser_download_url: `https://example.com/${assetName}.sha256`,
    });
  }
  return { tag_name: tag, assets };
}

// Stub fetch returning a GitHub release object
function stubFetch(release: object, binaryContent = 'fake-binary') {
  return vi.fn(async (url: string) => {
    if (String(url).includes('api.github.com')) {
      return { ok: true, status: 200, json: async () => release };
    }
    if (String(url).includes('.sha256')) {
      const hash = createHash('sha256').update(binaryContent).digest('hex');
      return { ok: true, status: 200, body: true, text: async () => `${hash}  horus-v99.0.0` };
    }
    // Binary download. NOTE: .buffer alone would return Buffer's pooled 8KB
    // slab (wrong bytes, wrong length) — slice to the content's exact range.
    const buf = Buffer.from(binaryContent);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { ok: true, status: 200, body: true, arrayBuffer: async () => ab };
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// --check flag
// ---------------------------------------------------------------------------

const CURRENT = '0.1.16';

describe('runUpdate --check', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports new version available', async () => {
    const release = makeRelease('99.0.0');
    const { lines, code } = await capture((w) =>
      runUpdate({ check: true, write: w, _fetch: stubFetch(release), _currentVersion: CURRENT }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('99.0.0'))).toBe(true);
    expect(lines.some((l) => l.includes('available'))).toBe(true);
  });

  it('reports already up to date when latest matches current', async () => {
    const release = makeRelease(CURRENT);
    const { lines, code } = await capture((w) =>
      runUpdate({ check: true, write: w, _fetch: stubFetch(release), _currentVersion: CURRENT }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.toLowerCase().includes('latest'))).toBe(true);
  });

  it('returns 1 when GitHub is unreachable', async () => {
    const failFetch = vi.fn(async () => { throw new Error('Network error'); }) as unknown as typeof fetch;
    const { code } = await capture((w) =>
      runUpdate({ check: true, write: w, _fetch: failFetch, _currentVersion: CURRENT }),
    );
    expect(code).toBe(1);
  });

  it('returns 1 when GitHub returns non-ok', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false, status: 503, json: async () => ({}),
    })) as unknown as typeof fetch;
    const { code, lines } = await capture((w) =>
      runUpdate({ check: true, write: w, _fetch: failFetch, _currentVersion: CURRENT }),
    );
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes('503'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Already up-to-date (no --force)
// ---------------------------------------------------------------------------

describe('runUpdate — already latest', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits 0 without downloading when already latest', async () => {
    const release = makeRelease(CURRENT);
    const _fetch = stubFetch(release);
    const { code } = await capture((w) =>
      runUpdate({ write: w, _fetch, _currentVersion: CURRENT }),
    );
    expect(code).toBe(0);
    // fetch called once (API only), no binary download
    expect(_fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Binary not found in release assets
// ---------------------------------------------------------------------------

describe('runUpdate — missing asset', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns 1 and prints fallback hint when asset not in release', async () => {
    const release = { tag_name: 'v99.0.0', assets: [] };
    const { code, lines } = await capture((w) =>
      runUpdate({ write: w, _fetch: stubFetch(release), _currentVersion: CURRENT }),
    );
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes('install.sh'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Self-update wheel refresh (PR #35 review, discussion_r3513589546)
// ---------------------------------------------------------------------------

vi.mock('../lib/bundled-backend.js', () => ({
  installBundledBackend: vi.fn(async () => true),
  resolveBundledWheel: vi.fn(() => null),
}));
vi.mock('@horus/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/connectors')>();
  return { ...actual, getSourceVersion: vi.fn(async () => '0.0.1') };
});

describe('runUpdate — self-update backend wheel refresh', () => {
  const LATEST = '99.0.0';
  const BIN_CONTENT = 'new-binary-bytes';

  function releaseWithWheel() {
    const r = makeRelease(LATEST, true);
    r.assets.push({
      name: 'horus_source.whl',
      browser_download_url: 'https://example.com/horus_source.whl',
    });
    return r;
  }

  /** stubFetch + a controllable wheel-asset branch. */
  function stubFetchWithWheel(release: object, wheelOk: boolean) {
    const base = stubFetch(release, BIN_CONTENT);
    return vi.fn(async (url: string) => {
      if (String(url).includes('horus_source.whl')) {
        return wheelOk
          ? {
              ok: true,
              status: 200,
              body: true,
              arrayBuffer: async () => {
                const b = Buffer.from('new-wheel-bytes');
                return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
              },
            }
          : { ok: false, status: 404, body: null };
      }
      return (base as unknown as (u: string) => Promise<unknown>)(url);
    }) as unknown as typeof fetch;
  }

  let dir: string;
  let binPath: string;
  let origArgv1: string | undefined;

  beforeEach(async () => {
    const { mkdtempSync, writeFileSync: wfs } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j } = await import('node:path');
    dir = mkdtempSync(j(tmpdir(), 'horus-update-'));
    binPath = j(dir, 'horus');
    wfs(binPath, 'old-binary');
    origArgv1 = process.argv[1];
    process.argv[1] = binPath;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    process.argv[1] = origArgv1!;
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('REGRESSION: a failed wheel download never reuses the stale sibling wheel as the new version', async () => {
    const { installBundledBackend } = await import('../lib/bundled-backend.js');
    const { lines, code } = await capture((w) =>
      runUpdate({ write: w, _fetch: stubFetchWithWheel(releaseWithWheel(), false), _currentVersion: CURRENT }),
    );
    expect(code).toBe(0); // binary update itself succeeded
    const out = lines.join('\n');
    expect(out).toContain('Updated:');
    // The pinning step must SKIP, not stage the old sibling wheel as 99.0.0.
    expect(vi.mocked(installBundledBackend)).not.toHaveBeenCalled();
    expect(out).toContain("wasn't downloaded — skipping backend install");
  });

  it('a confirmed wheel download is passed explicitly to the backend install', async () => {
    const { installBundledBackend } = await import('../lib/bundled-backend.js');
    const { readFileSync: rfs, realpathSync } = await import('node:fs');
    const { join: j, dirname: dn } = await import('node:path');
    const { lines, code } = await capture((w) =>
      runUpdate({ write: w, _fetch: stubFetchWithWheel(releaseWithWheel(), true), _currentVersion: CURRENT }),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Bundled backend wheel refreshed');
    // resolveBinaryPath realpaths argv[1] (macOS: /var -> /private/var).
    const expectedWheel = j(dn(realpathSync(binPath)), 'horus_source.whl');
    expect(rfs(expectedWheel, 'utf8')).toBe('new-wheel-bytes');
    expect(vi.mocked(installBundledBackend)).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(installBundledBackend).mock.calls[0]![1] as Record<string, unknown>;
    expect(opts['version']).toBe(LATEST);
    expect(opts['_wheelPath']).toBe(expectedWheel);
  });
});
