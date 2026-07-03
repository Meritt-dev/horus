import { describe, it, expect } from 'vitest';
import type { RepoProvider } from '@horus/connectors';
import { reposHealth } from './multi-repo.js';
describe('reposHealth identity (dogfood finding 5 — two repos, one port)', () => {
  it('a healthy host serving ANOTHER repo reads as unreachable/foreign, not running', async () => {
    const mkProvider = (name: string, path: string): RepoProvider => ({
      name,
      path,
      hostUrl: 'http://127.0.0.1:8420', // both registered on the SHARED default port
      code: { health: async () => ({ ok: true, detail: 'responded 200' }) } as never,
    });
    const a = mkProvider('repo-a', '/repos/a');
    const b = mkProvider('repo-b', '/repos/b');
    // The live process on :8420 serves repo-a only.
    const served = async (_url: string) => '/repos/a';

    const health = await reposHealth([a, b], served);
    const byName = Object.fromEntries(health.map((h) => [h.repo, h]));
    expect(byName['repo-a']!.reachable).toBe(true);
    expect(byName['repo-b']!.reachable).toBe(false);
    expect(byName['repo-b']!.detail).toContain('foreign host');
    // Running count derived from reachable must be 1, not 2.
    expect(health.filter((h) => h.reachable)).toHaveLength(1);
  });

  it('identity-unknown (old backend) keeps back-compat reachability', async () => {
    const p: RepoProvider = {
      name: 'repo-c',
      path: '/repos/c',
      hostUrl: 'http://127.0.0.1:8421',
      code: { health: async () => ({ ok: true, detail: 'responded 200' }) } as never,
    };
    const health = await reposHealth([p], async () => null);
    expect(health[0]!.reachable).toBe(true);
  });
});
