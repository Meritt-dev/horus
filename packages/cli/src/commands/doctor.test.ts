import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runDoctor, CONNECTOR_CHECKS, DOCTOR_CONNECTOR_KEYS } from './doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureOutput(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-doctor-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

// Stub DB checks injected into all tests to avoid live Postgres calls in CI.
const stubDbReady = async () => ({
  reachable: true,
  schemaReady: true,
  reachableDetail: 'connected',
  schemaDetail: '9 tables present',
});

const stubDbUnreachable = async () => ({
  reachable: false,
  schemaReady: false,
  reachableDetail: 'unreachable',
  schemaDetail: 'cannot check',
});

// ---------------------------------------------------------------------------
// Existing checks (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('runDoctor', () => {
  it('exits 0 in a fully configured repo (healthy case)', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, '.horus'));
    writeFileSync(
      join(root, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'test-project',
          repositories: [
            { name: 'test-project', path: root, source: { hostUrl: 'http://127.0.0.1:8420' } },
          ],
          environments: [{ name: 'production', readOnly: true, connectors: {} }],
        },
      }),
    );
    const code = await runDoctor({ cwd: root, _dbCheck: stubDbReady });
    expect(code).toBe(0);
  });

  it('exits 0 (warn, not fail) when local config is missing', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    // No .horus/config.json — missing setup case
    const code = await runDoctor({ cwd: root, _dbCheck: stubDbUnreachable });
    expect(code).toBe(0);
  });

  it('exits 0 (warn) when not in a git repository', async () => {
    const root = tempDir();
    // No git init
    const code = await runDoctor({ cwd: root, _dbCheck: stubDbUnreachable });
    expect(code).toBe(0);
  });

  it('exits 0 (warn) when source-intelligence host is not configured', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, '.horus'));
    writeFileSync(
      join(root, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'test-project',
          repositories: [{ name: 'test-project', path: root }], // no source
          environments: [{ name: 'production', readOnly: true, connectors: {} }],
        },
      }),
    );
    const code = await runDoctor({ cwd: root, _dbCheck: stubDbUnreachable });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HOR-85: Elasticsearch connector check
// ---------------------------------------------------------------------------

function writeJsConfig(dir: string, content: string): string {
  const path = join(dir, 'horus.config.js');
  writeFileSync(path, content);
  return path;
}

const DB = `{ url: "postgresql://horus:horus@localhost:5433/horus" }`;

describe('runDoctor — Elasticsearch present (HOR-85)', () => {
  it('exits 0 and shows indexPattern in output', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { elasticsearch: { indexPattern: "my-api-prod-*" } },
    }],
  }],
};
`);
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('my-api-prod-*');
    expect(output).toContain('Elasticsearch');
  });

  it('shows project/env context in the detail', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "leadcall",
    repositories: [{ name: "leadcall", path: "/repos/leadcall" }],
    environments: [{
      name: "production",
      connectors: { elasticsearch: { indexPattern: "leadcall-prod-*" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('leadcall/production');
  });

  it('does not print url, username, or password secrets', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: {
        elasticsearch: {
          indexPattern: "my-api-prod-*",
          url: "https://es-secret.example.com:9200",
          username: "elastic-user",
          password: "super-secret-password",
        },
      },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('es-secret.example.com');
    expect(output).not.toContain('elastic-user');
    expect(output).not.toContain('super-secret-password');
  });

  it('notes that runtime ingestion is pending even when configured', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { elasticsearch: { indexPattern: "logs-*" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(lines.join('\n')).toContain('pending');
  });
});

describe('runDoctor — Elasticsearch absent (HOR-85)', () => {
  it('shows "not configured" when no environment has ES', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(lines.join('\n')).toContain('not configured');
  });

  it('includes a next-step hint for absent ES config', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(lines.join('\n')).toContain('connectors.elasticsearch');
  });

  it('exits 0 (warn, not fail) for absent ES', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { code } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
  });
});

describe('runDoctor — Elasticsearch partial (indexPattern missing) (HOR-85)', () => {
  it('shows warn status when indexPattern is absent', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { elasticsearch: { indexPattern: "" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('indexPattern not set');
    expect(output).toContain('set indexPattern');
  });
});

describe('runDoctor — no global config (HOR-85)', () => {
  it('skips ES check when no global config is loadable', async () => {
    const root = tempDir();
    // No horus.config.js, no horus.config.ts, no HORUS_CONFIG
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbUnreachable, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('Elasticsearch');
  });

  it('skips all connector checks when no global config is loadable', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbUnreachable, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('Grafana');
    expect(output).not.toContain('MongoDB');
    expect(output).not.toContain('Redis');
  });

  it('still outputs existing checks when global config is absent', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbUnreachable, write }),
    );
    expect(lines.join('\n')).toContain('CLI version');
  });
});

// ---------------------------------------------------------------------------
// HOR-100: fix hints for missing prerequisites
// ---------------------------------------------------------------------------

const stubDbReadyNoSchema = async () => ({
  reachable: true,
  schemaReady: false,
  reachableDetail: 'connected',
  schemaDetail: 'missing: investigations',
});

describe('runDoctor — fix hints (HOR-100)', () => {
  it('shows horus init hint when local config is missing', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbUnreachable, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('horus init');
  });

  it('shows docker run hint when database is not reachable', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbUnreachable, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('docker run');
    expect(output).toContain('postgres:16');
  });

  it('shows DATABASE_URL hint when database is not reachable', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbUnreachable, write }),
    );
    expect(lines.join('\n')).toContain('DATABASE_URL');
  });

  it('shows pnpm db migrate hint when schema is not applied', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbReadyNoSchema, write }),
    );
    expect(lines.join('\n')).toContain('pnpm db migrate');
  });

  it('shows Database pass when db is healthy', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('Database');
    expect(output).toContain('9 tables present');
  });

  it('shows horus init hint when source-intelligence host is not configured', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, '.horus'));
    writeFileSync(
      join(root, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'test-project',
          repositories: [{ name: 'test-project', path: root }], // no source
          environments: [{ name: 'production', readOnly: true, connectors: {} }],
        },
      }),
    );
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbUnreachable, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('horus init');
  });

  it('exits 0 (warn, not fail) for all missing prerequisites', async () => {
    const root = tempDir();
    const { code } = await captureOutput((write) =>
      runDoctor({ cwd: root, _dbCheck: stubDbUnreachable, write }),
    );
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HOR-107: Grafana connector checks
// ---------------------------------------------------------------------------

describe('runDoctor — Grafana present (HOR-107)', () => {
  it('shows pass and project/env context when Grafana URL is configured', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { grafana: { url: "https://grafana.internal:3000" } },
    }],
  }],
};
`);
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('Grafana');
    expect(output).toContain('my-api/production');
  });

  it('shows dashboard name in detail when configured', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { grafana: { url: "https://grafana.internal:3000", dashboard: "api-overview" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(lines.join('\n')).toContain('api-overview');
  });

  it('does not print Grafana URL, username, or password secrets', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: {
        grafana: {
          url: "https://grafana-secret.example.com:3000",
          username: "grafana-admin",
          password: "grafana-password-secret",
        },
      },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('grafana-secret.example.com');
    expect(output).not.toContain('grafana-admin');
    expect(output).not.toContain('grafana-password-secret');
  });
});

describe('runDoctor — Grafana absent (HOR-107)', () => {
  it('shows "not configured" when no environment has Grafana', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(lines.join('\n')).toContain('Grafana');
    expect(lines.join('\n')).toContain('not configured');
  });

  it('includes a next-step hint for absent Grafana', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(lines.join('\n')).toContain('connectors.grafana');
  });
});

describe('runDoctor — Grafana partial (URL missing) (HOR-107)', () => {
  it('shows warn when grafana is configured without a URL', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { grafana: { dashboard: "overview" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('URL not set');
    expect(output).toContain('grafana.url');
  });
});

// ---------------------------------------------------------------------------
// HOR-107: MongoDB connector checks
// ---------------------------------------------------------------------------

describe('runDoctor — MongoDB present (HOR-107)', () => {
  it('shows pass and database name when MongoDB URL is configured', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { mongodb: { url: "mongodb://localhost:27017", database: "my-api-prod" } },
    }],
  }],
};
`);
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('MongoDB');
    expect(output).toContain('my-api-prod');
  });

  it('does not print MongoDB connection URL secrets', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: {
        mongodb: {
          url: "mongodb://secret-user:secret-pass@mongo.internal:27017/mydb",
          database: "mydb",
        },
      },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('secret-user');
    expect(output).not.toContain('secret-pass');
    expect(output).not.toContain('mongo.internal');
  });
});

describe('runDoctor — MongoDB absent (HOR-107)', () => {
  it('shows "not configured" when no environment has MongoDB', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('MongoDB');
    expect(output).toContain('not configured');
  });

  it('includes a next-step hint for absent MongoDB', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(lines.join('\n')).toContain('connectors.mongodb');
  });
});

describe('runDoctor — MongoDB partial (URL missing) (HOR-107)', () => {
  it('shows warn when mongodb is configured without a URL', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { mongodb: { database: "my-api-prod" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('URL not set');
    expect(output).toContain('mongodb.url');
  });
});

// ---------------------------------------------------------------------------
// HOR-107: Redis connector checks
// ---------------------------------------------------------------------------

describe('runDoctor — Redis present (HOR-107)', () => {
  it('shows pass when Redis URL is configured', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { redis: { url: "redis://localhost:6379" } },
    }],
  }],
};
`);
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('Redis');
    expect(output).toContain('my-api/production');
  });

  it('does not print Redis URL secrets', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { redis: { url: "redis://:redis-secret-pass@redis.internal:6379" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('redis-secret-pass');
    expect(output).not.toContain('redis.internal');
  });
});

describe('runDoctor — Redis absent (HOR-107)', () => {
  it('shows "not configured" when no environment has Redis', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('Redis');
    expect(output).toContain('not configured');
  });

  it('includes a next-step hint for absent Redis', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(lines.join('\n')).toContain('connectors.redis');
  });
});

describe('runDoctor — Redis partial (URL missing) (HOR-107)', () => {
  it('shows warn when redis is configured without a URL', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { redis: {} },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('URL not set');
    expect(output).toContain('redis.url');
  });
});

// ---------------------------------------------------------------------------
// HOR-130 — --json / machine-readable output
// ---------------------------------------------------------------------------

describe('runDoctor --json', () => {
  it('outputs valid JSON with version, ready, checks, and summary fields', async () => {
    const root = tempDir();
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ cwd: root, json: true, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const out = JSON.parse(lines.join(''));
    expect(out).toHaveProperty('version');
    expect(typeof out.version).toBe('string');
    expect(out).toHaveProperty('ready', true);
    expect(Array.isArray(out.checks)).toBe(true);
    expect(out).toHaveProperty('summary');
    expect(typeof out.summary.pass).toBe('number');
    expect(typeof out.summary.warn).toBe('number');
    expect(typeof out.summary.fail).toBe('number');
  });

  it('each check has label, status, and detail fields', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, json: true, _dbCheck: stubDbReady, write }),
    );
    const out = JSON.parse(lines.join(''));
    for (const check of out.checks) {
      expect(check).toHaveProperty('label');
      expect(check).toHaveProperty('status');
      expect(['pass', 'warn', 'fail']).toContain(check.status);
      expect(check).toHaveProperty('detail');
    }
  });

  it('always includes a CLI version check with status pass', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, json: true, _dbCheck: stubDbUnreachable, write }),
    );
    const out = JSON.parse(lines.join(''));
    const versionCheck = out.checks.find((c: { label: string }) => c.label === 'CLI version');
    expect(versionCheck).toBeDefined();
    expect(versionCheck.status).toBe('pass');
  });

  it('reports Database as warn when DB is unreachable', async () => {
    const root = tempDir();
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ cwd: root, json: true, _dbCheck: stubDbUnreachable, write }),
    );
    expect(code).toBe(0); // warn does not fail
    const out = JSON.parse(lines.join(''));
    const dbCheck = out.checks.find((c: { label: string }) => c.label === 'Database');
    expect(dbCheck).toBeDefined();
    expect(dbCheck.status).toBe('warn');
    expect(out.ready).toBe(true); // warn-only → ready (no fail checks)
    expect(out.summary.warn).toBeGreaterThan(0);
  });

  it('reports Database as pass when DB is healthy', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, '.horus'));
    writeFileSync(
      join(root, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'json-test',
          repositories: [{ name: 'json-test', path: root }],
          environments: [{ name: 'production', readOnly: true, connectors: {} }],
        },
      }),
    );
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ cwd: root, json: true, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const out = JSON.parse(lines.join(''));
    const dbCheck = out.checks.find((c: { label: string }) => c.label === 'Database');
    expect(dbCheck.status).toBe('pass');
    expect(out.summary.pass).toBeGreaterThanOrEqual(1);
  });

  it('does not output human-readable text when --json is set', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, json: true, _dbCheck: stubDbReady, write }),
    );
    const raw = lines.join('\n');
    expect(raw).not.toContain('Horus readiness check');
    expect(raw).not.toContain('✓');
    expect(raw).not.toContain('~');
  });

  it('summary counts are consistent with checks array', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, json: true, _dbCheck: stubDbUnreachable, write }),
    );
    const out = JSON.parse(lines.join(''));
    const passCount = out.checks.filter((c: { status: string }) => c.status === 'pass').length;
    const warnCount = out.checks.filter((c: { status: string }) => c.status === 'warn').length;
    const failCount = out.checks.filter((c: { status: string }) => c.status === 'fail').length;
    expect(out.summary.pass).toBe(passCount);
    expect(out.summary.warn).toBe(warnCount);
    expect(out.summary.fail).toBe(failCount);
  });
});

// ---------------------------------------------------------------------------
// HOR-437: doctor must cover EVERY configured connector (Axiom + future ones)
//
// The bug: doctor's connector checks were a hardcoded list (ES, Grafana, Mongo,
// Postgres, Sentry, Redis) that was never updated when Axiom was added — so
// `horus doctor` silently skipped Axiom. The fix drives the checks off the
// connector registry (exhaustive over `keyof ConnectorsConfig`), so these tests
// assert coverage of the WHOLE supported set, not a fixed snapshot.
// ---------------------------------------------------------------------------

describe('runDoctor — full connector coverage (HOR-437)', () => {
  it('the registry covers the full supported connector set including axiom', () => {
    const keys = new Set(DOCTOR_CONNECTOR_KEYS as string[]);
    for (const expected of [
      'elasticsearch',
      'grafana',
      'sentry',
      'mongodb',
      'postgres',
      'redis',
      'axiom',
    ]) {
      expect(keys.has(expected)).toBe(true);
    }
  });

  it('reports a readiness line for EVERY connector type (registry-driven)', async () => {
    // An env with no connectors configured — every registry connector should still
    // produce a "not configured" readiness line. Driven off CONNECTOR_CHECKS so a
    // newly-added connector cannot be silently omitted from this assertion.
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ config: configPath, json: true, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const out = JSON.parse(lines.join(''));
    const labels = new Set<string>(out.checks.map((c: { label: string }) => c.label));
    for (const key of DOCTOR_CONNECTOR_KEYS) {
      expect(labels.has(CONNECTOR_CHECKS[key].label)).toBe(true);
    }
    // Explicitly confirm Axiom — the connector the old hardcoded list missed.
    expect(labels.has('Axiom')).toBe(true);
  });

  it('reports a line for every configured connector when ALL are present', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: {
        elasticsearch: { indexPattern: "my-api-prod-*" },
        grafana: { url: "https://grafana.internal:3000" },
        mongodb: { url: "mongodb://localhost:27017", database: "my-api" },
        postgres: { url: "postgresql://localhost:5432/my-api", database: "my-api" },
        sentry: { org: "acme", project: "my-api", authToken: "sentry-tok" },
        axiom: { dataset: "my-api-logs", token: "axiom-tok" },
        redis: { url: "redis://localhost:6379" },
      },
    }],
  }],
};
`);
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ config: configPath, json: true, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const out = JSON.parse(lines.join(''));
    const labels = new Set<string>(out.checks.map((c: { label: string }) => c.label));
    for (const key of DOCTOR_CONNECTOR_KEYS) {
      expect(labels.has(CONNECTOR_CHECKS[key].label)).toBe(true);
    }
  });
});

describe('runDoctor — Axiom present (HOR-437)', () => {
  it('shows pass and the dataset when Axiom token + dataset are configured', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { axiom: { dataset: "my-api-logs", token: "axiom-secret-token" } },
    }],
  }],
};
`);
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('Axiom');
    expect(output).toContain('my-api-logs');
    expect(output).toContain('my-api/production');
    expect(output).toContain('pending');
  });

  it('does not print the Axiom API token secret', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { axiom: { dataset: "my-api-logs", token: "axiom-secret-token", url: "https://axiom-secret.example.com" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('axiom-secret-token');
    expect(output).not.toContain('axiom-secret.example.com');
  });

  it('warns when Axiom is configured without a token', async () => {
    const dir = tempDir();
    const prev = process.env['AXIOM_TOKEN'];
    delete process.env['AXIOM_TOKEN'];
    try {
      const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { axiom: { dataset: "my-api-logs" } },
    }],
  }],
};
`);
      const { lines } = await captureOutput((write) =>
        runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
      );
      const output = lines.join('\n');
      expect(output).toContain('API token not set');
      expect(output).toContain('axiom.token');
    } finally {
      if (prev !== undefined) process.env['AXIOM_TOKEN'] = prev;
    }
  });
});

describe('runDoctor — Axiom absent (HOR-437)', () => {
  it('shows "not configured" and a hint when no environment has Axiom', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, _dbCheck: stubDbReady, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('Axiom');
    expect(output).toContain('not configured');
    expect(output).toContain('connectors.axiom');
  });
});
