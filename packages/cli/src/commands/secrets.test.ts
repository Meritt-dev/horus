import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeLocalConfig,
  localConfigPath,
  localSecretsPath,
  readLocalConfig,
  loadConfig,
  resolveEnvironment,
  decryptConnectorSecrets,
  resetMasterKeyCache,
} from '@horus/core';
import { runConnect } from './connect.js';
import { runSecretsMigrate, runSecretsStatus } from './secrets.js';

const ORIGINAL_ENV = process.env['HORUS_SECRET_KEY'];
let root: string;

function seedConfig(connectors: Record<string, unknown>): void {
  writeLocalConfig(root, {
    version: 1,
    project: {
      name: 'p',
      repositories: [{ name: 'p', path: root }],
      environments: [{ name: 'production', connectors }],
    },
  });
}

beforeEach(() => {
  process.env['HORUS_SECRET_KEY'] = 'cli-secrets-test-key';
  resetMasterKeyCache();
  root = mkdtempSync(join(tmpdir(), 'horus-cli-sec-'));
  // Keep command chatter out of the test output.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env['HORUS_SECRET_KEY'];
  else process.env['HORUS_SECRET_KEY'] = ORIGINAL_ENV;
  resetMasterKeyCache();
  vi.restoreAllMocks();
});

describe('horus connect routes credentials to the encrypted store (HOR-452)', () => {
  it('encrypts the axiom token and keeps only dataset in config.json', async () => {
    seedConfig({});
    const code = await runConnect('axiom', {
      dataset: 'maison-safqa-logs',
      token: 'xaat-00d4e547-90c8-4ec0-b1b0-511fecc8458f',
      noTest: true,
      cwd: root,
    });
    expect(code).toBe(0);

    // config.json: dataset present, token absent.
    const cfgRaw = readFileSync(localConfigPath(root), 'utf8');
    expect(cfgRaw).toContain('maison-safqa-logs');
    expect(cfgRaw).not.toContain('xaat-00d4e547');

    // secrets.local.json: ciphertext, not the plaintext token.
    const secRaw = readFileSync(localSecretsPath(root), 'utf8');
    expect(secRaw).not.toContain('xaat-00d4e547');
    const { values } = decryptConnectorSecrets(root);
    expect(values['production']!['axiom']!['token']).toBe(
      'xaat-00d4e547-90c8-4ec0-b1b0-511fecc8458f',
    );

    // Round-trip through the resolver.
    const config = await loadConfig(localConfigPath(root));
    const env = resolveEnvironment(config, { env: 'production' });
    expect(env.connectors.axiom?.dataset).toBe('maison-safqa-logs');
    expect(env.connectors.axiom?.token).toBe('xaat-00d4e547-90c8-4ec0-b1b0-511fecc8458f');
  });

  it('encrypts the mongodb connection string (whole url is a secret)', async () => {
    seedConfig({});
    const code = await runConnect('mongodb', {
      database: 'app',
      url: 'mongodb://user:s3cr3t@db.internal:27017/app',
      noTest: true,
      cwd: root,
    });
    expect(code).toBe(0);
    expect(readFileSync(localConfigPath(root), 'utf8')).not.toContain('s3cr3t');
    const { values } = decryptConnectorSecrets(root);
    expect(values['production']!['mongodb']!['url']).toContain('s3cr3t');
  });
});

describe('horus secrets migrate (HOR-452)', () => {
  it('moves an existing plaintext token into the encrypted store and strips config', () => {
    // The exact shape from the user's report — a plaintext axiom token in config.
    seedConfig({ axiom: { dataset: 'maison-safqa-logs', token: 'xaat-PLAINTEXT' } });

    const code = runSecretsMigrate({ cwd: root });
    expect(code).toBe(0);

    const after = readLocalConfig(localConfigPath(root));
    const axiom = (after.project as { environments: Array<{ connectors: { axiom: Record<string, unknown> } }> })
      .environments[0]!.connectors.axiom;
    expect(axiom['dataset']).toBe('maison-safqa-logs');
    expect(axiom['token']).toBeUndefined();

    const { values } = decryptConnectorSecrets(root);
    expect(values['production']!['axiom']!['token']).toBe('xaat-PLAINTEXT');
  });

  it('--dry-run reports but does not change anything', () => {
    seedConfig({ axiom: { dataset: 'd', token: 'xaat-DRY' } });
    const before = readFileSync(localConfigPath(root), 'utf8');
    const code = runSecretsMigrate({ cwd: root, dryRun: true });
    expect(code).toBe(0);
    expect(readFileSync(localConfigPath(root), 'utf8')).toBe(before);
  });

  it('is a no-op (exit 0) when there is nothing to migrate', () => {
    seedConfig({ axiom: { dataset: 'd' } });
    expect(runSecretsMigrate({ cwd: root })).toBe(0);
  });

  it('errors when no config exists', () => {
    expect(runSecretsMigrate({ cwd: root })).toBe(1);
  });
});

describe('horus secrets status', () => {
  it('returns 0 and runs without a config', () => {
    expect(runSecretsStatus({ cwd: root })).toBe(0);
  });
});

it('round-trips SQL Server, Kafka and Prometheus credentials through the existing encrypted store', async () => {
  seedConfig({});
  for (const [kind, opts] of [
    ['sqlserver',{url:'Server=localhost;User Id=reader;Password=sql-private;Database=app',database:'app',tables:'orders'}],
    ['kafka',{brokers:'localhost:9092',topics:'orders',groups:'worker',username:'reader',password:'kafka-private',ssl:false}],
    ['prometheus',{url:'https://metrics.example',token:'prom-private',queries:'[{"title":"up","expr":"up"}]'}],
  ] as const) expect(await runConnect(kind,{...opts,noTest:true,cwd:root})).toBe(0);
  const disk=readFileSync(localConfigPath(root),'utf8')+readFileSync(localSecretsPath(root),'utf8');
  const output=JSON.stringify(vi.mocked(console.log).mock.calls);
  for(const secret of ['sql-private','kafka-private','prom-private']) {expect(disk).not.toContain(secret);expect(output).not.toContain(secret);}
  const env=resolveEnvironment(await loadConfig(localConfigPath(root)));
  expect(env.connectors.sqlserver?.url).toContain('sql-private');
  expect(env.connectors.kafka?.password).toBe('kafka-private');
  expect(env.connectors.prometheus?.token).toBe('prom-private');
});
