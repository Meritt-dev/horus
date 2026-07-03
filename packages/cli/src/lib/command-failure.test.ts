/**
 * Shared machine-JSON failure contract (dogfood 0.21.1 A1).
 *
 * A data command that fails BEFORE producing output must still leave stdout as ONE
 * parseable JSON object under `--json` (agents pipe stdout to json.load) — never empty,
 * never a raw stack trace. `failCommand` is that contract; here we pin both its shape and
 * an end-to-end path (`horus search --json` from a config-less cwd).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failCommand } from './command-failure.js';
import { runSearch } from '../commands/search.js';

describe('failCommand — shared JSON-failure contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits one { ok:false, detail } object on stdout under --json + the detail on stderr', () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(String(a[0])));
    vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(String(a[0])));

    const code = failCommand(new Error('No Horus config found.'), true);

    expect(code).toBe(1);
    const parsed = JSON.parse(out.join('\n')) as { ok: boolean; detail: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toBe('No Horus config found.');
    // Human detail still goes to stderr (agents read stdout; humans read stderr).
    expect(err.join('\n')).toContain('No Horus config found.');
  });

  it('writes NOTHING to stdout when json is falsy (human mode unchanged)', () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(String(a[0])));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = failCommand(new Error('boom'), false);

    expect(code).toBe(1);
    expect(out.join('')).toBe('');
  });

  it('falls back to String(err) when the error carries no message', () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(String(a[0])));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    failCommand('plain string failure', true);

    const parsed = JSON.parse(out.join('\n')) as { ok: boolean; detail: string };
    expect(parsed.detail).toBe('plain string failure');
  });
});

describe('data command --json failure end-to-end (no config)', () => {
  const realCwd = process.cwd();
  afterEach(() => {
    process.chdir(realCwd);
    vi.restoreAllMocks();
  });

  it('search --json from a config-less cwd prints parseable JSON with ok:false (no stack trace)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'horus-nocfg-'));
    process.chdir(dir);

    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(String(a[0])));
    vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(String(a[0])));

    const code = await runSearch('anything', { json: true });

    expect(code).toBe(1);
    const parsed = JSON.parse(out.join('\n')) as { ok: boolean; detail: string };
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.detail).toBe('string');
    // stderr is the clean one-liner, NOT a raw JS stack (no "at loadConfig (" frames).
    expect(err.join('\n')).not.toContain('at loadConfig');
  });
});
