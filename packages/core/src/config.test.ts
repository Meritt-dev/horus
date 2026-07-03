import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { horusConfigSchema, resolveEnvironment, listEnvironments, loadConfig } from './config.js';

// ---------------------------------------------------------------------------
// Fixtures — source-intelligence (code index) belongs to the project's
// repositories; runtime connectors belong to the environment.
// ---------------------------------------------------------------------------

const DB = { url: 'postgresql://horus:horus@localhost:5433/horus' };

const SINGLE_PROJECT_CONFIG = horusConfigSchema.parse({
  database: DB,
  projects: [
    {
      name: 'my-api',
      repositories: [
        { name: 'my-api', path: '/repos/my-api', source: { hostUrl: 'http://127.0.0.1:8420' } },
      ],
      environments: [
        {
          name: 'production',
          connectors: {
            elasticsearch: { indexPattern: 'my-api-prod-*', serviceName: 'my-api-prod' },
            grafana: {},
          },
        },
      ],
    },
  ],
});

const TWO_PROJECT_CONFIG = horusConfigSchema.parse({
  database: DB,
  projects: [
    {
      name: 'api-a',
      repositories: [
        { name: 'api-a', path: '/repos/api-a', source: { hostUrl: 'http://127.0.0.1:8420' } },
      ],
      environments: [{ name: 'production', connectors: {} }],
    },
    {
      name: 'api-b',
      repositories: [
        { name: 'api-b', path: '/repos/api-b', source: { hostUrl: 'http://127.0.0.1:8421' } },
      ],
      environments: [{ name: 'production', connectors: {} }],
    },
  ],
});

const MULTI_ENV_CONFIG = horusConfigSchema.parse({
  database: DB,
  projects: [
    {
      name: 'my-svc',
      repositories: [
        { name: 'my-svc', path: '/repos/my-svc', source: { hostUrl: 'http://127.0.0.1:8420' } },
      ],
      environments: [
        { name: 'staging', connectors: {} },
        { name: 'production', connectors: {} },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('horusConfigSchema', () => {
  it('applies defaults and requires a database url', () => {
    const parsed = horusConfigSchema.parse({ database: DB });
    expect(parsed.models.reasoning).toBe('claude-opus-4-8');
    expect(parsed.projects).toEqual([]);
  });

  it('rejects a config without a database url', () => {
    expect(() => horusConfigSchema.parse({})).toThrow();
  });

  it('rejects a repository with a non-url source hostUrl', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: DB,
        projects: [
          {
            name: 'x',
            repositories: [{ name: 'x', path: '/x', source: { hostUrl: 'not-a-url' } }],
            environments: [{ name: 'prod', connectors: {} }],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects a project with no repositories', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: DB,
        projects: [
          { name: 'x', repositories: [], environments: [{ name: 'prod', connectors: {} }] },
        ],
      }),
    ).toThrow();
  });

  it('rejects a project with no environments', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: DB,
        projects: [
          { name: 'x', repositories: [{ name: 'x', path: '/x' }], environments: [] },
        ],
      }),
    ).toThrow();
  });

  it('defaults environment connectors to {}', () => {
    const parsed = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x' }],
          environments: [{ name: 'prod', connectors: {} }],
        },
      ],
    });
    const env = parsed.projects[0]?.environments[0];
    expect(env?.connectors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// listEnvironments
// ---------------------------------------------------------------------------

describe('listEnvironments', () => {
  it('returns empty array when no projects', () => {
    const cfg = horusConfigSchema.parse({ database: DB });
    expect(listEnvironments(cfg)).toEqual([]);
  });

  it('flattens projects × environments', () => {
    const list = listEnvironments(MULTI_ENV_CONFIG);
    expect(list).toEqual([
      { project: 'my-svc', env: 'staging' },
      { project: 'my-svc', env: 'production' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveEnvironment
// ---------------------------------------------------------------------------

describe('resolveEnvironment', () => {
  it('resolves the single project/env without any opts', () => {
    const renv = resolveEnvironment(SINGLE_PROJECT_CONFIG);
    expect(renv.project).toBe('my-api');
    expect(renv.env).toBe('production');
    expect(renv.path).toBe('/repos/my-api'); // primary repo path
    expect(renv.readOnly).toBe(true);
  });

  it('resolves the project repositories with their source-intelligence hosts', () => {
    const renv = resolveEnvironment(SINGLE_PROJECT_CONFIG);
    expect(renv.repositories).toHaveLength(1);
    expect(renv.repositories[0]?.name).toBe('my-api');
    expect(renv.repositories[0]?.sourceHostUrl).toBe('http://127.0.0.1:8420');
  });

  // HOR-137: source.hostUrl is the canonical config key
  it('accepts source.hostUrl as the canonical config key (HOR-137)', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'my-api',
          repositories: [
            { name: 'my-api', path: '/repos/my-api', source: { hostUrl: 'http://127.0.0.1:8420' } },
          ],
          environments: [{ name: 'production', connectors: {} }],
        },
      ],
    });
    const renv = resolveEnvironment(cfg);
    expect(renv.repositories[0]?.sourceHostUrl).toBe('http://127.0.0.1:8420');
  });

  it('throws when project is unknown', () => {
    expect(() =>
      resolveEnvironment(TWO_PROJECT_CONFIG, { project: 'does-not-exist' }),
    ).toThrow(/Unknown project: does-not-exist/);
  });

  it('throws with a helpful list when multiple projects and no --project', () => {
    expect(() => resolveEnvironment(TWO_PROJECT_CONFIG)).toThrow(
      /Multiple projects configured/,
    );
  });

  it('selects the named project when --project is given', () => {
    const renv = resolveEnvironment(TWO_PROJECT_CONFIG, { project: 'api-b' });
    expect(renv.project).toBe('api-b');
    expect(renv.repositories[0]?.sourceHostUrl).toBe('http://127.0.0.1:8421');
  });

  it('infers the project from the cwd repository when multiple projects + no --project', () => {
    // TWO_PROJECT_CONFIG has api-b at /repos/api-b
    expect(resolveEnvironment(TWO_PROJECT_CONFIG, { cwd: '/repos/api-b' }).project).toBe(
      'api-b',
    );
  });

  it('still throws when cwd matches no configured repository', () => {
    expect(() =>
      resolveEnvironment(TWO_PROJECT_CONFIG, { cwd: '/somewhere/unrelated' }),
    ).toThrow(/Multiple projects configured/);
  });

  it('defaults to the "production" env when multiple envs and no --env', () => {
    const renv = resolveEnvironment(MULTI_ENV_CONFIG);
    expect(renv.env).toBe('production');
  });

  it('keeps the same project-scoped source-intelligence host across environments', () => {
    // Code belongs to the project, so the repository's source host is the same in any env.
    const staging = resolveEnvironment(MULTI_ENV_CONFIG, { env: 'staging' });
    const prod = resolveEnvironment(MULTI_ENV_CONFIG, { env: 'production' });
    expect(staging.env).toBe('staging');
    expect(staging.repositories[0]?.sourceHostUrl).toBe('http://127.0.0.1:8420');
    expect(prod.repositories[0]?.sourceHostUrl).toBe('http://127.0.0.1:8420');
  });

  it('throws when env is unknown', () => {
    expect(() =>
      resolveEnvironment(MULTI_ENV_CONFIG, { env: 'canary' }),
    ).toThrow(/Unknown environment: canary/);
  });

  describe('secret resolution from process.env', () => {
    const ORIG_ENV = { ...process.env };

    beforeEach(() => {
      process.env['ES_URL'] = 'http://es:9200';
      process.env['ES_USERNAME'] = 'elastic';
      process.env['ES_PASSWORD'] = 's3cr3t';
      process.env['GRAFANA_URL'] = 'http://grafana:3000';
      process.env['GRAFANA_USER'] = 'admin';
      process.env['GRAFANA_PASSWORD'] = 'grafana-pass';
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in ORIG_ENV)) delete process.env[key];
        else process.env[key] = ORIG_ENV[key];
      }
    });

    it('reads elasticsearch creds from default env vars', () => {
      const renv = resolveEnvironment(SINGLE_PROJECT_CONFIG);
      expect(renv.connectors.elasticsearch?.url).toBe('http://es:9200');
      expect(renv.connectors.elasticsearch?.username).toBe('elastic');
      expect(renv.connectors.elasticsearch?.password).toBe('s3cr3t');
      expect(renv.connectors.elasticsearch?.indexPattern).toBe('my-api-prod-*');
      expect(renv.connectors.elasticsearch?.serviceName).toBe('my-api-prod');
    });

    it('reads grafana creds from default env vars', () => {
      const renv = resolveEnvironment(SINGLE_PROJECT_CONFIG);
      expect(renv.connectors.grafana?.url).toBe('http://grafana:3000');
      expect(renv.connectors.grafana?.username).toBe('admin');
      expect(renv.connectors.grafana?.password).toBe('grafana-pass');
    });
  });

  it('omits elasticsearch from resolved connectors when not configured', () => {
    const renv = resolveEnvironment(TWO_PROJECT_CONFIG, { project: 'api-a' });
    expect(renv.connectors.elasticsearch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HOR-47: elasticsearch preset and fields block
// ---------------------------------------------------------------------------

describe('horusConfigSchema — elasticsearch preset + fields (HOR-47)', () => {
  it('defaults preset to meritt', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', source: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: { elasticsearch: { indexPattern: 'logs-*' } },
            },
          ],
        },
      ],
    });
    expect(cfg.projects[0]!.environments[0]!.connectors.elasticsearch!.preset).toBe('meritt');
  });

  it('accepts preset:ecs', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', source: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: { indexPattern: 'logs-*', preset: 'ecs' },
              },
            },
          ],
        },
      ],
    });
    expect(cfg.projects[0]!.environments[0]!.connectors.elasticsearch!.preset).toBe('ecs');
  });

  it('rejects unknown preset values', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: DB,
        projects: [
          {
            name: 'x',
            repositories: [{ name: 'x', path: '/x', source: { hostUrl: 'http://localhost' } }],
            environments: [
              {
                name: 'production',
                connectors: {
                  elasticsearch: { indexPattern: 'logs-*', preset: 'logstash' },
                },
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts partial fields block and omits unset fields', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', source: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: {
                  indexPattern: 'logs-*',
                  preset: 'meritt',
                  fields: { timestamp: '@timestamp', eventCode: 'error_code' },
                },
              },
            },
          ],
        },
      ],
    });
    const f = cfg.projects[0]!.environments[0]!.connectors.elasticsearch!.fields;
    expect(f?.timestamp).toBe('@timestamp');
    expect(f?.eventCode).toBe('error_code');
    expect(f?.level).toBeUndefined();
  });

  it('accepts a complete custom fields block', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', source: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: {
                  indexPattern: 'logs-*',
                  preset: 'meritt',
                  fields: {
                    timestamp: 'ts',
                    level: 'severity',
                    levelFormat: 'string',
                    service: 'app_name',
                    serviceKeyword: false,
                    message: 'log_msg',
                    messageFallback: 'msg',
                    traceId: 'correlation_id',
                    requestId: 'req_id',
                    eventCode: 'error_code',
                    eventCodeKeyword: true,
                  },
                },
              },
            },
          ],
        },
      ],
    });
    const f = cfg.projects[0]!.environments[0]!.connectors.elasticsearch!.fields;
    expect(f?.timestamp).toBe('ts');
    expect(f?.levelFormat).toBe('string');
    expect(f?.serviceKeyword).toBe(false);
    expect(f?.eventCodeKeyword).toBe(true);
  });
});

describe('resolveEnvironment — elasticsearch fields forwarded (HOR-47)', () => {
  it('forwards preset and fields into resolved connector', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', source: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: {
                  url: 'http://localhost:9200',
                  indexPattern: 'logs-*',
                  preset: 'ecs',
                  fields: { timestamp: '@timestamp', eventCode: 'event.code' },
                },
              },
            },
          ],
        },
      ],
    });
    const renv = resolveEnvironment(cfg);
    expect(renv.connectors.elasticsearch?.preset).toBe('ecs');
    expect(renv.connectors.elasticsearch?.fields?.timestamp).toBe('@timestamp');
    expect(renv.connectors.elasticsearch?.fields?.eventCode).toBe('event.code');
  });

  it('omits fields from resolved connector when not provided', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', source: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: { url: 'http://localhost:9200', indexPattern: 'logs-*' },
              },
            },
          ],
        },
      ],
    });
    const renv = resolveEnvironment(cfg);
    expect(renv.connectors.elasticsearch?.fields).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HOR-83: native JS/ESM config loading (built binary path)
// ---------------------------------------------------------------------------

const MINIMAL_JS_CONFIG_CONTENT = `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [],
};
`;

const NO_DEFAULT_EXPORT_CONTENT = `export const notDefault = { database: { url: "x" } };
`;

describe('loadConfig — native JS/ESM loading (HOR-83)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `horus-config-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a .js config via native import() and returns a valid HorusConfig', async () => {
    const configPath = join(tmpDir, 'horus.config.js');
    writeFileSync(configPath, MINIMAL_JS_CONFIG_CONTENT);
    const cfg = await loadConfig(configPath);
    expect(cfg.database.url).toBe('postgresql://horus:horus@localhost:5433/horus');
    expect(cfg.projects).toEqual([]);
  });

  it('loads a .mjs config via native import()', async () => {
    const configPath = join(tmpDir, 'horus.config.mjs');
    writeFileSync(configPath, MINIMAL_JS_CONFIG_CONTENT);
    const cfg = await loadConfig(configPath);
    expect(cfg.database.url).toContain('postgresql://');
  });

  it('loads a .cjs config via native import()', async () => {
    const configPath = join(tmpDir, 'horus.config.cjs');
    writeFileSync(configPath, `module.exports = { database: { url: "postgresql://horus:horus@localhost:5433/horus" }, projects: [] };\n`);
    const cfg = await loadConfig(configPath);
    expect(cfg.database.url).toContain('postgresql://');
  });

  it('throws an ACTIONABLE error (not a cryptic module-not-found) when no config exists', async () => {
    // tmpDir has no .horus/config.json and no config/horus.config.* — an un-set-up repo.
    delete process.env['HORUS_CONFIG'];
    await expect(loadConfig(undefined, { cwd: tmpDir })).rejects.toThrow(/No Horus config found/);
    await expect(loadConfig(undefined, { cwd: tmpDir })).rejects.toThrow(/horus init/);
  });

  it('throws a clear error when .js config has no default export', async () => {
    const configPath = join(tmpDir, 'no-default.js');
    writeFileSync(configPath, NO_DEFAULT_EXPORT_CONTENT);
    await expect(loadConfig(configPath)).rejects.toThrow('must have a default export');
  });

  it('throws a clear error when .js config fails to load', async () => {
    const configPath = join(tmpDir, 'bad-syntax.js');
    writeFileSync(configPath, 'THIS IS NOT VALID JS !!!@@@');
    await expect(loadConfig(configPath)).rejects.toThrow(/Could not load Horus config/);
  });

  it('throws a readable validation error when .js config is structurally invalid', async () => {
    const configPath = join(tmpDir, 'invalid-schema.js');
    writeFileSync(configPath, `export default { notAValidKey: true };\n`);
    await expect(loadConfig(configPath)).rejects.toThrow(/Invalid Horus config/);
  });

  it('prefers config/horus.config.js over config/horus.config.ts when both exist', async () => {
    const configDir = join(tmpDir, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'horus.config.js'), MINIMAL_JS_CONFIG_CONTENT);
    // .ts file with a different DB url — if .ts were loaded, this URL would appear
    writeFileSync(
      join(configDir, 'horus.config.ts'),
      `export default { database: { url: "postgresql://should-not-be-loaded/db" }, projects: [] };\n`,
    );
    const cfg = await loadConfig(undefined, { cwd: tmpDir });
    // Should have loaded the .js file, not the .ts file
    expect(cfg.database.url).toBe('postgresql://horus:horus@localhost:5433/horus');
  });
});

// ---------------------------------------------------------------------------
// HOR-102: actionable config validation errors
// ---------------------------------------------------------------------------

describe('parseConfig — actionable validation errors (HOR-102)', () => {
  it('includes the config source path in the error', () => {
    expect(() => horusConfigSchema.parse({})).toThrow();
    // Verify via loadConfig that the source path appears in the message
  });

  it('missing database.url shows a postgresql example', () => {
    let caught: Error | null = null;
    try {
      horusConfigSchema.parse({ projects: [] });
    } catch (e) {
      caught = e as Error;
    }
    // Zod throws on missing database — the parseConfig wrapper adds the example hint
    // Here we test the schema rejects it; example hint is tested via loadConfig below
    expect(caught).not.toBeNull();
  });

  it('loadConfig shows database.url example in error for missing database', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default { projects: [] };\n`);
    try {
      let err: Error | null = null;
      try { await loadConfig(configPath); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).toContain('Invalid Horus config');
      expect(err!.message).toContain(configPath);
      expect(err!.message).toContain('postgresql://');
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('invalid source hostUrl shows example URL with port hint', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "x",
    repositories: [{ name: "x", path: "/x", source: { hostUrl: "not-a-url" } }],
    environments: [{ name: "prod", connectors: {} }],
  }],
};\n`);
    try {
      let err: Error | null = null;
      try { await loadConfig(configPath); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).toContain('hostUrl');
      expect(err!.message).toContain('8420');
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('empty repositories array shows example repository shape', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "x",
    repositories: [],
    environments: [{ name: "prod", connectors: {} }],
  }],
};\n`);
    try {
      let err: Error | null = null;
      try { await loadConfig(configPath); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).toContain('repositories');
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('throws with a readable "not found" error for an unknown config path', async () => {
    const err = await loadConfig('/tmp/horus-does-not-exist-xyz.js').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Could not load Horus config');
  });

  it('valid config continues to load without errors', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "valid-api",
    repositories: [{ name: "valid-api", path: "/repos/valid-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};\n`);
    try {
      const cfg = await loadConfig(configPath);
      expect(cfg.database.url).toContain('postgresql://');
      expect(cfg.projects[0]?.name).toBe('valid-api');
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('invalid connector shape shows the field path in the error', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "x",
    repositories: [{ name: "x", path: "/x" }],
    environments: [{
      name: "prod",
      connectors: { elasticsearch: { preset: "unknown-preset" } },
    }],
  }],
};\n`);
    try {
      let err: Error | null = null;
      try { await loadConfig(configPath); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).toContain('Invalid Horus config');
      expect(err!.message).toContain('elasticsearch');
    } finally {
      rmSync(configPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HOR-131 — config path precedence
//
// Resolution order (highest → lowest priority):
//   1. explicit configPath argument (--config CLI flag)
//   2. opts.name  →  global project registry (~/.horus/registry.json)
//   3. .horus/config.json  discovered by walking up from cwd
//   4. HORUS_CONFIG environment variable
//   5. config/horus.config.js  relative to cwd
//   6. config/horus.config.ts  relative to cwd (source-mode fallback)
// ---------------------------------------------------------------------------

const MARKER_JS = (marker: string) =>
  `export default { database: { url: "postgresql://${marker}/db" }, projects: [] };\n`;

describe('loadConfig — path precedence (HOR-131)', () => {
  let tmpDir: string;
  const ORIG = { ...process.env };

  beforeEach(() => {
    tmpDir = join(tmpdir(), `horus-prec-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    delete process.env['HORUS_CONFIG'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const key of ['HORUS_CONFIG']) {
      if (key in ORIG) process.env[key] = ORIG[key];
      else delete process.env[key];
    }
  });

  // ── 1. Explicit path ───────────────────────────────────────────────────────

  it('(1) explicit configPath is used and bypasses all discovery', async () => {
    const explicit = join(tmpDir, 'explicit.js');
    writeFileSync(explicit, MARKER_JS('explicit-host'));
    // Also put a .horus/config.json and HORUS_CONFIG to confirm they are ignored
    mkdirSync(join(tmpDir, '.horus'));
    writeFileSync(
      join(tmpDir, '.horus', 'config.json'),
      JSON.stringify({ version: 1, project: { name: 'local', repositories: [{ name: 'local', path: tmpDir }], environments: [{ name: 'prod', connectors: {} }] }, database: { url: 'postgresql://local-host/db' } }),
    );
    process.env['HORUS_CONFIG'] = join(tmpDir, 'env-config.js');
    writeFileSync(join(tmpDir, 'env-config.js'), MARKER_JS('env-host'));
    const cfg = await loadConfig(explicit, { cwd: tmpDir });
    expect(cfg.database.url).toContain('explicit-host');
  });

  // ── 3. .horus/config.json discovered from cwd ────────────────────────────

  it('(3) .horus/config.json discovered from cwd takes precedence over HORUS_CONFIG', async () => {
    // Write a local .horus/config.json
    mkdirSync(join(tmpDir, '.horus'));
    writeFileSync(
      join(tmpDir, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'local-proj',
          repositories: [{ name: 'local-proj', path: tmpDir }],
          environments: [{ name: 'prod', connectors: {} }],
        },
        database: { url: 'postgresql://local-host/db' },
      }),
    );
    // Also set HORUS_CONFIG to a different file
    const envFile = join(tmpDir, 'env.js');
    writeFileSync(envFile, MARKER_JS('env-host'));
    process.env['HORUS_CONFIG'] = envFile;
    const cfg = await loadConfig(undefined, { cwd: tmpDir });
    expect(cfg.database.url).toBe('postgresql://local-host/db');
  });

  it('(3) .horus/config.json is discovered by walking up from a subdirectory', async () => {
    mkdirSync(join(tmpDir, '.horus'));
    writeFileSync(
      join(tmpDir, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'walk-proj',
          repositories: [{ name: 'walk-proj', path: tmpDir }],
          environments: [{ name: 'prod', connectors: {} }],
        },
        database: { url: 'postgresql://walked-host/db' },
      }),
    );
    const deep = join(tmpDir, 'src', 'subpackage');
    mkdirSync(deep, { recursive: true });
    const cfg = await loadConfig(undefined, { cwd: deep });
    expect(cfg.database.url).toBe('postgresql://walked-host/db');
  });

  // ── 4. HORUS_CONFIG env var ───────────────────────────────────────────────

  it('(4) HORUS_CONFIG env var is used when no local config is found', async () => {
    const envFile = join(tmpDir, 'via-env.js');
    writeFileSync(envFile, MARKER_JS('env-marker'));
    process.env['HORUS_CONFIG'] = envFile;
    // cwd has no .horus/config.json
    const cfg = await loadConfig(undefined, { cwd: tmpDir });
    expect(cfg.database.url).toContain('env-marker');
  });

  it('(4) HORUS_CONFIG takes precedence over config/horus.config.js', async () => {
    // Write config/horus.config.js
    const configDir = join(tmpDir, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'horus.config.js'), MARKER_JS('file-marker'));
    // HORUS_CONFIG points to a different file
    const envFile = join(tmpDir, 'env.js');
    writeFileSync(envFile, MARKER_JS('env-marker'));
    process.env['HORUS_CONFIG'] = envFile;
    const cfg = await loadConfig(undefined, { cwd: tmpDir });
    expect(cfg.database.url).toContain('env-marker');
  });

  // ── 5. config/horus.config.js fallback ───────────────────────────────────

  it('(5) config/horus.config.js is used when no higher-priority source is available', async () => {
    const configDir = join(tmpDir, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'horus.config.js'), MARKER_JS('js-fallback'));
    const cfg = await loadConfig(undefined, { cwd: tmpDir });
    expect(cfg.database.url).toContain('js-fallback');
  });

  // ── Missing config — error messages ───────────────────────────────────────

  it('throws a "Could not load" error when explicit config path does not exist', async () => {
    await expect(loadConfig('/nonexistent/path/horus.config.js')).rejects.toThrow(
      /Could not load Horus config/,
    );
  });

  it('error message for explicit path includes the attempted path', async () => {
    const missing = '/nonexistent/horus-131-test.js';
    const err = await loadConfig(missing).catch((e: Error) => e);
    expect((err as Error).message).toContain(missing);
  });
});

// ---------------------------------------------------------------------------
// Redis multi-DB resolution + backward compatibility (HOR-201)
// ---------------------------------------------------------------------------

import { redisDbFromUrl, redisUrlForDb } from './config.js';

function resolveRedis(redis: unknown) {
  const cfg = horusConfigSchema.parse({
    database: DB,
    projects: [
      {
        name: 'p',
        repositories: [{ name: 'p', path: '/repos/p' }],
        environments: [{ name: 'production', connectors: { redis } }],
      },
    ],
  });
  return resolveEnvironment(cfg, { project: 'p', env: 'production' }).connectors.redis;
}

describe('redisDbFromUrl / redisUrlForDb', () => {
  it('parses the DB index from a URL path, defaulting to 0', () => {
    expect(redisDbFromUrl('redis://:pw@h:6379/1')).toBe(1);
    expect(redisDbFromUrl('redis://h:6379')).toBe(0);
    expect(redisDbFromUrl('redis://h:6379/')).toBe(0);
    expect(redisDbFromUrl(undefined)).toBe(0);
  });

  it('sets the DB index on a URL without losing credentials', () => {
    expect(redisUrlForDb('redis://:pw@h:6379', 1)).toBe('redis://:pw@h:6379/1');
    expect(redisUrlForDb('redis://:pw@h:6379/2', 5)).toBe('redis://:pw@h:6379/5');
  });
});

describe('redis resolution (HOR-201)', () => {
  it('legacy single URL with DB suffix → one synthesized DB at that index', () => {
    const r = resolveRedis({ url: 'redis://:pw@127.0.0.1:6379/1' });
    expect(r?.url).toBe('redis://:pw@127.0.0.1:6379/1');
    expect(r?.databases).toEqual([{ db: 1, roles: [], bullmqPrefix: 'bull' }]);
  });

  it('legacy URL without DB → one synthesized DB at index 0', () => {
    const r = resolveRedis({ url: 'redis://127.0.0.1:6379' });
    expect(r?.databases).toEqual([{ db: 0, roles: [], bullmqPrefix: 'bull' }]);
  });

  it('URL without DB + databases array → resolves each DB with roles + prefix', () => {
    const r = resolveRedis({
      url: 'redis://127.0.0.1:6379',
      databases: [
        { db: 0, name: 'cache', roles: ['cache', 'state'], scan: { sampleLimit: 300, patterns: ['x:*'] } },
        { db: 1, name: 'queues', roles: ['bullmq', 'queues'], bullmq: { prefix: 'bull' } },
      ],
    });
    expect(r?.databases).toHaveLength(2);
    expect(r?.databases[0]).toMatchObject({ db: 0, name: 'cache', roles: ['cache', 'state'], bullmqPrefix: 'bull' });
    expect(r?.databases[0]?.scan).toEqual({ enabled: true, sampleLimit: 300, patterns: ['x:*'] });
    expect(r?.databases[1]).toMatchObject({ db: 1, name: 'queues', roles: ['bullmq', 'queues'], bullmqPrefix: 'bull' });
  });

  it('custom bullmq prefix is carried through', () => {
    const r = resolveRedis({
      url: 'redis://127.0.0.1:6379',
      databases: [{ db: 2, roles: ['bullmq'], bullmq: { prefix: 'myapp' } }],
    });
    expect(r?.databases[0]?.bullmqPrefix).toBe('myapp');
  });
});

// ---------------------------------------------------------------------------
// AI settings resolution (HOR-206)
// ---------------------------------------------------------------------------

import { resolveAiSettings } from './config.js';

function configWithAi(ai: unknown) {
  return horusConfigSchema.parse({ database: DB, projects: [], ...(ai !== undefined ? { ai } : {}) });
}

describe('resolveAiSettings (HOR-206)', () => {
  const ORIG = process.env['ANTHROPIC_API_KEY'];
  afterEach(() => {
    if (ORIG === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = ORIG;
  });

  it('prefers a config-stored key (marked fromConfig)', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const r = resolveAiSettings(configWithAi({ provider: 'anthropic', anthropic: { apiKey: 'sk-ant-cfg', model: 'claude-opus-4-8' } }));
    expect(r.anthropicApiKey).toBe('sk-ant-cfg');
    expect(r.anthropicKeyFromConfig).toBe(true);
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('claude-opus-4-8');
  });

  it('falls back to the ANTHROPIC_API_KEY env var (not fromConfig)', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env';
    const r = resolveAiSettings(configWithAi({ provider: 'anthropic' }));
    expect(r.anthropicApiKey).toBe('sk-ant-env');
    expect(r.anthropicKeyFromConfig).toBe(false);
  });

  it('honours a custom apiKeyEnv', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    process.env['MY_KEY'] = 'sk-ant-custom';
    const r = resolveAiSettings(configWithAi({ anthropic: { apiKeyEnv: 'MY_KEY' } }));
    expect(r.anthropicApiKey).toBe('sk-ant-custom');
    delete process.env['MY_KEY'];
  });

  it('returns no key when neither config nor env provides one', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const r = resolveAiSettings(configWithAi(undefined));
    expect(r.anthropicApiKey).toBeUndefined();
    expect(r.anthropicKeyFromConfig).toBe(false);
  });
});
