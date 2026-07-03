/**
 * `pickContextTarget` — the shared context/cloud-link picker.
 *
 * The interactive selection itself is covered by tty-selector's own tests; here we
 * pin the NON-interactive contract (no TTY in CI/agents), so the new picker can never
 * silently hang or mis-resolve a scripted run:
 *   - with cloud projects but no TTY → null (caller must require an explicit target)
 *   - includeLocal with zero projects → "local" (the only sensible pick)
 *   - nothing pickable → null
 * Plus the deterministic triple/label mapping via resolveTriple.
 */
import { describe, it, expect } from 'vitest';
import type { ContextResponse } from '../lib/cloud/api.js';
import { pickContextTarget, resolveTriple } from './context.js';

function ctx(projects: Array<{ slug: string; name?: string }>): ContextResponse {
  return {
    user: { id: 'u1', primaryEmail: 'dev@x.dev' },
    organizations: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
    workspaces: [{ id: 'w1', slug: 'main', name: 'Main', organizationId: 'o1' }],
    projects: projects.map((p, i) => ({
      id: `p${i}`,
      slug: p.slug,
      name: p.name ?? p.slug,
      workspaceId: 'w1',
      organizationId: 'o1',
    })),
  } as unknown as ContextResponse;
}

describe('pickContextTarget (non-interactive contract)', () => {
  it('returns null for cloud projects when not a TTY — the caller requires an explicit target', async () => {
    // vitest runs without a TTY, so isInteractive() is false: the picker must not hang.
    const picked = await pickContextTarget(ctx([{ slug: 'web' }, { slug: 'api' }]));
    expect(picked).toBeNull();
  });

  it('returns "local" when includeLocal and there are no cloud projects', async () => {
    const picked = await pickContextTarget(ctx([]), { includeLocal: true });
    expect(picked).toBe('local');
  });

  it('returns null when nothing is pickable and local is not offered', async () => {
    const picked = await pickContextTarget(ctx([]));
    expect(picked).toBeNull();
  });
});

describe('resolveTriple (deterministic slug resolution — unchanged)', () => {
  it('resolves a valid org/workspace/project triple', () => {
    const r = resolveTriple(ctx([{ slug: 'web' }]), 'acme/main/web');
    expect(r).toMatchObject({
      organization: { slug: 'acme' },
      workspace: { slug: 'main' },
      project: { slug: 'web' },
    });
  });

  it('returns null for a triple the user cannot access', () => {
    expect(resolveTriple(ctx([{ slug: 'web' }]), 'acme/main/nope')).toBeNull();
    expect(resolveTriple(ctx([{ slug: 'web' }]), 'malformed')).toBeNull();
  });
});
