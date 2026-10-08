import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InvestigationReport } from '@horus/engine';
import type { WatchJobData } from './watch-store.js';
import { incidentResultSchema } from './claude-investigation.js';
import {
  applyRepairPatch,
  repairEligible,
  repairFile,
  repairIncident,
} from './incident-repair.js';

const directories: string[] = [];
const temp = () => {
  const directory = mkdtempSync(join(tmpdir(), 'horus-repair-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const originals = { 'src/example.ts': 'setQuantity();' };
const patch = {
  summary: 'Activate the item first',
  changes: [
    {
      path: 'src/example.ts',
      before: 'setQuantity();',
      after: 'activate(); setQuantity();',
    },
  ],
};

it('validates all patch files before writing and replays an applied patch without repeating it', () => {
  const root = temp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/example.ts'), 'setQuantity();');
  expect(() =>
    applyRepairPatch(
      root,
      {
        ...patch,
        changes: [
          ...patch.changes,
          { path: 'src/other.ts', before: 'old', after: 'new' },
        ],
      },
      ['src/example.ts'],
      originals,
    ),
  ).toThrow('unrequested');
  expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toBe('setQuantity();');
  applyRepairPatch(root, patch, ['src/example.ts'], originals);
  applyRepairPatch(root, patch, ['src/example.ts'], originals);
  expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toBe(
    'activate(); setQuantity();',
  );
  for (const path of [
    '../outside.ts',
    '.env',
    '.git/config.ts',
    '/tmp/outside.ts',
    'vite.config.ts',
    'src/plugin.config.js',
  ])
    expect(() => repairFile(root, path)).toThrow();
  symlinkSync(temp(), join(root, 'linked'));
  expect(() => repairFile(root, 'linked/example.ts')).toThrow('symlink');
});

it('preserves literal dollar replacement sequences in proposed source', () => {
  const root = temp();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/example.ts'), originals['src/example.ts']);
  const after = 'const literal = "$& $$ $` $\'"; setQuantity();';
  applyRepairPatch(
    root,
    { ...patch, changes: [{ ...patch.changes[0]!, after }] },
    ['src/example.ts'],
    originals,
  );
  expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toBe(after);
});

it('does not authorize a code PR from uncertain, failed or empty runtime evidence', () => {
  const result = incidentResultSchema.parse({
    reportId: 'c2de50b7-267f-4b93-85c8-ef0b906c7b3e',
    summary: 'Missing activation',
    likelyCause: 'Not stocked',
    confidence: 0.8,
    evidenceIds: ['e1'],
    historicalMemoryIds: [],
    nextChecks: ['Review patch'],
    uncertainty: '',
    diagnosis: 'supported',
    codeFix: { reason: 'Missing activation', files: ['src/example.ts'] },
  });
  const report = {
    evidence: [
      { id: 'e1', payload: { followup: true, observations: 1, evidence: [{}] } },
    ],
  } as InvestigationReport;
  expect(repairEligible(report, result)).toBe(true);
  expect(repairEligible(report, { ...result, diagnosis: 'unresolved' })).toBe(false);
  expect(
    repairEligible(
      {
        ...report,
        evidence: [
          {
            ...report.evidence[0]!,
            payload: { followup: true, observations: 0, evidence: [{}] },
          },
        ],
      },
      result,
    ),
  ).toBe(false);
  expect(
    repairEligible(
      {
        ...report,
        evidence: [
          {
            ...report.evidence[0]!,
            payload: { followup: true, error: 'Unavailable', evidence: [] },
          },
        ],
      },
      result,
    ),
  ).toBe(false);
});

it.each(['patch', 'manual'])(
  'runs isolated tool-free coding and recovers a proposal without duplicate calls (%s)',
  async (mode) => {
    const root = temp(),
      home = temp();
    const report = {
      id: 'c2de50b7-267f-4b93-85c8-ef0b906c7b3e',
      evidence: [],
    } as unknown as InvestigationReport;
    const branch = 'codex/horus-fix-' + report.id;
    const ai = incidentResultSchema.parse({
      reportId: report.id,
      summary: patch.summary,
      likelyCause: 'Not stocked',
      confidence: 0.8,
      evidenceIds: [],
      historicalMemoryIds: [],
      nextChecks: ['Review'],
      uncertainty: '',
      diagnosis: 'supported',
      codeFix: { reason: 'Missing activation', files: ['src/example.ts'] },
    });
    const job = { ai: { result: ai } } as WatchJobData;
    let head = 'a'.repeat(40),
      pr: string | undefined,
      prState = 'OPEN';
    const calls: { exe: string; args: string[] }[] = [];
    const runner = vi.fn(
      async (exe: string, args: string[], options: { cwd: string; input?: string }) => {
        calls.push({ exe, args });
        if (exe === 'git') {
          const command = args.slice(2);
          if (command[0] === 'remote') return 'git@github.com:owner/repo.git\n';
          if (command[0] === 'rev-parse')
            return (
              (command[1]!.endsWith('/base') || command[1] === 'HEAD^'
                ? 'a'.repeat(40)
                : head) + '\n'
            );
          if (command[0] === 'log') return `fix: incident ${report.id}`;
          if (command[0] === 'diff' && command[1] === '--name-only')
            return 'src/example.ts';
          if (command[0] === 'branch')
            return command[1] === '--show-current' ? branch : '';
          if (command[0] === 'worktree' && command[1] === 'add') {
            const directory = command[4]!;
            mkdirSync(join(directory, 'src'), { recursive: true });
            writeFileSync(join(directory, 'src/example.ts'), 'setQuantity();');
          }
          if (command[0] === 'commit') head = 'b'.repeat(40);
          return '';
        }
        if (exe === 'gh') {
          if (args[1] === 'list')
            return JSON.stringify(
              pr ? [{ url: pr, headRefName: branch, state: prState }] : [],
            );
          pr = 'https://github.com/owner/repo/pull/1';
          throw new Error('Lost creation response');
        }
        expect(options.cwd).not.toBe(root);
        expect(args[args.indexOf('--tools') + 1]).toBe('');
        expect(args).toContain('--strict-mcp-config');
        return JSON.stringify({
          type: 'result',
          is_error: false,
          result: JSON.stringify(
            mode === 'manual'
              ? { summary: 'Manual investigation required', changes: [] }
              : patch,
          ),
        });
      },
    );
    const reserveModelCall = vi.fn(async () => {});
    const options = {
      root,
      home,
      claude: 'claude-fixture',
      config: { repository: 'owner/repo', baseBranch: 'master' },
      report,
      job,
      signal: new AbortController().signal,
      remaining: () => 30000,
      reserveModelCall,
      checkpoint: async () => {},
      _run: runner,
    };
    if (mode === 'manual') {
      expect(await repairIncident(options)).toMatchObject({
        status: 'blocked',
        summary: 'Manual investigation required',
      });
      expect((await repairIncident(options)).status).toBe('blocked');
      expect(reserveModelCall).toHaveBeenCalledTimes(1);
      expect(calls.some((c) => c.exe === 'gh' && c.args[1] === 'create')).toBe(false);
      return;
    }
    await expect(repairIncident(options)).rejects.toThrow('Lost creation response');
    expect((await repairIncident(options)).url).toBe(pr);
    prState = 'CLOSED';
    expect((await repairIncident(options)).status).toBe('closed');
    prState = 'MERGED';
    expect((await repairIncident(options)).status).toBe('merged');
    expect(reserveModelCall).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.exe === 'gh' && c.args[1] === 'create')).toHaveLength(1);
    expect(calls.some((c) => c.exe === 'gh' && c.args.includes('--draft'))).toBe(true);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  },
);
