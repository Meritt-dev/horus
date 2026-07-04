/**
 * HOR-97 — Release readiness command tests.
 * HOR-212 — AI contract and prompt shape tests.
 *
 * Three canonical states:
 *   1. ready       — DB pass, source intelligence at pinned version, ES configured → exit 0, "Ready"
 *   2. partial     — DB pass, source intelligence missing, no global config → exit 0, warns about optional
 *   3. blocking    — DB unreachable → exit 1, "Not ready"
 *
 * All checks are injected; no live DB, source intelligence, or connector probes.
 */

import { describe, it, expect } from 'vitest';
import { runReadiness, READINESS_AI_CONTRACT } from './readiness.js';
import { buildInterpretationPrompt } from '@horus/ai';
import { PINNED_SOURCE_VERSION } from '@horus/core';
import type { DbHealth } from '@horus/db';
import type { loadConfig } from '@horus/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(out: string[]): string {
  return out.join('\n');
}

function capture(): { out: string[]; write: (l: string) => void } {
  const out: string[] = [];
  return { out, write: (l: string) => out.push(l) };
}

const DB_PASS: DbHealth = {
  reachable: true,
  reachableDetail: 'embedded (/home/u/.horus/horus.db)',
  schemaReady: true,
  schemaDetail: '13 tables present',
};
const DB_NOT_REACHABLE: DbHealth = {
  reachable: false,
  reachableDetail: 'embedded database unavailable — this build ships no local persistence',
  schemaReady: false,
  schemaDetail: 'install via npm or Homebrew for local persistence',
};

function makeConfig(opts: {
  sourceUrl?: string;
  elasticsearch?: boolean;
  grafana?: boolean;
  mongodb?: boolean;
  redis?: boolean;
}): Awaited<ReturnType<typeof loadConfig>> {
  const connectors: Record<string, unknown> = {};
  if (opts.elasticsearch) connectors['elasticsearch'] = { indexPattern: 'logs-*' };
  if (opts.grafana) connectors['grafana'] = { url: 'http://grafana.internal' };
  if (opts.mongodb) connectors['mongodb'] = { url: 'mongodb://localhost:27017', database: 'prod' };
  if (opts.redis) connectors['redis'] = { url: 'redis://localhost:6379' };

  return {
    database: { url: 'postgresql://horus:horus@localhost:5433/horus' },
    projects: [
      {
        name: 'test-project',
        repositories: [
          {
            name: 'test-repo',
            path: '/tmp/test-repo',
            ...(opts.sourceUrl ? { source: { hostUrl: opts.sourceUrl } } : {}),
          },
        ],
        environments: [
          {
            name: 'production',
            connectors: connectors as ReturnType<typeof loadConfig> extends Promise<infer T>
              ? never
              : never,
          },
        ],
      },
    ],
  } as unknown as Awaited<ReturnType<typeof loadConfig>>;
}

// ---------------------------------------------------------------------------
// 1. Ready state
// ---------------------------------------------------------------------------

describe('horus readiness — fully ready', () => {
  it('exits 0 when DB passes and source intelligence is at pinned version', async () => {
    const { out, write } = capture();
    const code = await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => PINNED_SOURCE_VERSION,
      _loadConfig: async () => makeConfig({ sourceUrl: 'http://localhost:8420', elasticsearch: true }),
    });
    expect(code).toBe(0);
    expect(lines(out)).toContain('Ready');
  });

  it('marks CLI check as pass', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => PINNED_SOURCE_VERSION,
      _loadConfig: async () => makeConfig({}),
    });
    expect(lines(out)).toContain('CLI');
  });

  it('marks Database check as pass with the embedded db path', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('Database');
    expect(output).toContain('embedded (/home/u/.horus/horus.db)');
  });

  it('marks source-intelligence backend as pass when version matches pinned', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => PINNED_SOURCE_VERSION,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('Source intelligence');
    expect(output).toContain('ready');
  });

  it('marks Elasticsearch as pass when configured', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => PINNED_SOURCE_VERSION,
      _loadConfig: async () => makeConfig({ elasticsearch: true }),
    });
    expect(lines(out)).toContain('Elasticsearch');
    // Should not suggest running connect
    const relevant = lines(out).split('\n').find(l => l.includes('Elasticsearch'));
    expect(relevant).not.toContain('→');
  });
});

// ---------------------------------------------------------------------------
// 2. Partial state (DB pass, optional items missing)
// ---------------------------------------------------------------------------

describe('horus readiness — partial (DB pass, optional items missing)', () => {
  it('exits 0 when DB passes even with no global config', async () => {
    const { out, write } = capture();
    const code = await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(code).toBe(0);
  });

  it('output mentions optional items not configured', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('optional item');
  });

  it('shows source-intelligence version mismatch as warn', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => '0.0.1',
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('version mismatch');
    expect(output).toContain(PINNED_SOURCE_VERSION);
  });

  it('source intelligence not installed — shows install hint', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('horus.sh/install.sh');
  });

  it('global config missing — points at horus init', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('horus init');
  });

  it('no source host URL in config — shows warn for Repo / Source host', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => PINNED_SOURCE_VERSION,
      _loadConfig: async () => makeConfig({}),
    });
    const output = lines(out);
    expect(output).toContain('Source host');
    expect(output).toContain('no source host URL');
  });

  it('connectors not configured — shows next steps', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _sourceVersion: async () => PINNED_SOURCE_VERSION,
      _loadConfig: async () => makeConfig({}),
    });
    const output = lines(out);
    expect(output).toContain('horus connect elasticsearch');
    expect(output).toContain('horus connect grafana');
    expect(output).toContain('horus connect mongodb');
    expect(output).toContain('horus connect redis');
    expect(output).toContain('horus connect axiom');
  });
});

// ---------------------------------------------------------------------------
// 3. Blocking state (DB not reachable / schema missing)
// ---------------------------------------------------------------------------

describe('horus readiness — blocking (DB failure)', () => {
  it('exits 1 when DB is not reachable', async () => {
    const { out, write } = capture();
    const code = await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(code).toBe(1);
  });

  it('output contains "Not ready" when DB unreachable', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('Not ready');
  });

  it('shows the install hint (not docker) when the embedded db is unavailable', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('install via npm or Homebrew');
    expect(output).not.toContain('docker run');
    expect(output).not.toContain('pnpm db migrate');
  });

  it('output separates Blocking from Optional sections', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('Blocking');
    expect(output).toContain('Optional');
  });

  it('re-run hint printed when blocking failures exist', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _sourceVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('Re-run');
  });
});

// ---------------------------------------------------------------------------
// HOR-212 — AI contract and prompt shape tests
// ---------------------------------------------------------------------------

const SAMPLE_CHECKS = [
  { label: 'CLI', status: 'pass', blocking: true, detail: 'horus 0.1.15' },
  { label: 'Database', status: 'fail', blocking: true, detail: 'embedded database unavailable', next: 'install via npm or Homebrew' },
  { label: 'Local config', status: 'warn', blocking: false, detail: '.horus/config.json not found', next: 'run horus init' },
  { label: 'Source intelligence', status: 'pass', blocking: false, detail: '0.3.1 — ready' },
  { label: 'Elasticsearch', status: 'warn', blocking: false, detail: 'not configured — no runtime log evidence' },
];

describe('READINESS_AI_CONTRACT (HOR-212)', () => {
  it('describes all required output sections', () => {
    expect(READINESS_AI_CONTRACT).toContain('Overall assessment');
    expect(READINESS_AI_CONTRACT).toContain('Blockers');
    expect(READINESS_AI_CONTRACT).toContain('Risks');
    expect(READINESS_AI_CONTRACT).toContain('Recommended next action');
    expect(READINESS_AI_CONTRACT).toContain('Confidence / gaps');
  });

  it('is a non-empty string', () => {
    expect(typeof READINESS_AI_CONTRACT).toBe('string');
    expect(READINESS_AI_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe('buildInterpretationPrompt for readiness (HOR-212)', () => {
  it('prompt contains the command name and readiness promptKind', () => {
    const prompt = buildInterpretationPrompt({
      command: 'readiness',
      evidence: SAMPLE_CHECKS,
      promptKind: 'readiness',
      outputContract: READINESS_AI_CONTRACT,
    });

    expect(prompt).toContain('readiness');
  });

  it('prompt serializes checks — blocking failure and optional warnings visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'readiness',
      evidence: SAMPLE_CHECKS,
      promptKind: 'readiness',
      outputContract: READINESS_AI_CONTRACT,
    });

    expect(prompt).toContain('Database');
    expect(prompt).toContain('embedded database unavailable');
    expect(prompt).toContain('Elasticsearch');
    expect(prompt).toContain('.horus/config.json not found');
  });

  it('prompt includes grounding rules', () => {
    const prompt = buildInterpretationPrompt({
      command: 'readiness',
      evidence: SAMPLE_CHECKS,
      promptKind: 'readiness',
      outputContract: READINESS_AI_CONTRACT,
    });

    expect(prompt).toContain('Use only the evidence provided above');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'readiness',
      evidence: SAMPLE_CHECKS,
      promptKind: 'readiness',
      outputContract: READINESS_AI_CONTRACT,
    });

    expect(prompt).toContain('Overall assessment');
    expect(prompt).toContain('Recommended next action');
    expect(prompt).toContain('Confidence / gaps');
  });
});
