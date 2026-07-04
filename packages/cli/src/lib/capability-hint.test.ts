/**
 * D6 — the shared reindex hint for inheritance-dependent commands (blast-radius / explain).
 * Gated on a class/interface seed AND a stale on-disk capability stamp; always suppressed
 * under --json so machine output never carries prose.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@horus/connectors', () => ({
  indexCapabilityStale: vi.fn(),
}));

import { indexCapabilityStale } from '@horus/connectors';
import { printCapabilityHint, isInheritanceSeed, CAPABILITY_HINT_TEXT } from './capability-hint.js';

const staleMock = vi.mocked(indexCapabilityStale);

describe('isInheritanceSeed', () => {
  it('is true only for class:/interface: node ids', () => {
    expect(isInheritanceSeed('class:src/a.ts:Foo')).toBe(true);
    expect(isInheritanceSeed('interface:src/a.ts:TSchema')).toBe(true);
    expect(isInheritanceSeed('function:src/a.ts:foo')).toBe(false);
    expect(isInheritanceSeed('method:src/a.ts:Foo.bar')).toBe(false);
    expect(isInheritanceSeed(undefined)).toBe(false);
    expect(isInheritanceSeed('')).toBe(false);
  });
});

describe('printCapabilityHint', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    staleMock.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints ONE dim hint for a class/interface seed against a stale index', () => {
    staleMock.mockReturnValue(true);
    printCapabilityHint('interface:src/type.ts:TSchema', { json: false });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect((logSpy.mock.calls[0]![0] as string)).toContain(CAPABILITY_HINT_TEXT);
  });

  it('is suppressed under --json even when stale', () => {
    staleMock.mockReturnValue(true);
    printCapabilityHint('class:src/type.ts:TObject', { json: true });
    expect(logSpy).not.toHaveBeenCalled();
    // Short-circuits before the stale check — never touches the index.
    expect(staleMock).not.toHaveBeenCalled();
  });

  it('does not print for a function seed (no subtypes)', () => {
    staleMock.mockReturnValue(true);
    printCapabilityHint('function:src/a.ts:handler', { json: false });
    expect(logSpy).not.toHaveBeenCalled();
    expect(staleMock).not.toHaveBeenCalled();
  });

  it('does not print when the index is fresh', () => {
    staleMock.mockReturnValue(false);
    printCapabilityHint('class:src/a.ts:Foo', { json: false });
    expect(logSpy).not.toHaveBeenCalled();
    expect(staleMock).toHaveBeenCalled();
  });
});
