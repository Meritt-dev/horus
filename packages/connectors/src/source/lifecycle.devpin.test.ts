/**
 * In unbundled dev/test runs the pin is HORUS_VERSION='dev', which matches no
 * real backend — enforcement is disabled so dev-mode host spawn/reuse never
 * blocks. This file deliberately does NOT mock @horus/core: it pins the real
 * dev-run behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { assertSourceVersionPinned } from './lifecycle.js';
import { SOURCE_PIN_ENFORCED } from '@horus/core';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string }) => void) =>
      cb(null, { stdout: 'horus-source 99.99.99\n' }),
  ),
  spawn: vi.fn(),
}));

describe('assertSourceVersionPinned (unenforced dev pin)', () => {
  it('never throws on drift when the pin is unenforced', async () => {
    expect(SOURCE_PIN_ENFORCED).toBe(false); // 'dev' build — precondition
    await expect(assertSourceVersionPinned()).resolves.toBeUndefined();
    // The probe is skipped entirely — no exec at all.
    expect(vi.mocked(childProcess.execFile)).not.toHaveBeenCalled();
  });
});
