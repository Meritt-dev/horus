import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  discoverLocalConfig,
  registryPath,
  findRepoRoot,
  writeLocalConfig,
  registerProject,
  lookupProject,
  readRegistry,
  ensureProjectGitignore,
  writeLocalSecrets,
  readLocalSecrets,
} from './discovery.js';

describe('discoverLocalConfig', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-disc-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds a .horus/config.json by walking up from a subdir', () => {
    writeLocalConfig(root, { version: 1, project: { name: 'x' } });
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(discoverLocalConfig(deep)).toBe(join(root, '.horus', 'config.json'));
  });

  it('returns null when no .horus exists up the tree', () => {
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(discoverLocalConfig(deep)).toBeNull();
  });
});

describe('findRepoRoot', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-git-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds the nearest .git ancestor', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const deep = join(root, 'src', 'deep');
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
  });
});

describe('ensureProjectGitignore', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-gi-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const gitignore = () => join(root, '.gitignore');

  it('does nothing when the repo is not a git repository', () => {
    ensureProjectGitignore(root);
    expect(existsSync(gitignore())).toBe(false);
  });

  it('creates .gitignore with a .horus/ entry when the repo is a git repo without one', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    ensureProjectGitignore(root);
    expect(readFileSync(gitignore(), 'utf8')).toBe('.horus/\n');
  });

  it('appends .horus/ to an existing .gitignore', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(gitignore(), 'node_modules\ndist\n');
    ensureProjectGitignore(root);
    expect(readFileSync(gitignore(), 'utf8')).toBe('node_modules\ndist\n.horus/\n');
  });

  it('is idempotent — does not duplicate an existing .horus entry (any common spelling)', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    for (const entry of ['.horus', '.horus/', '/.horus', '/.horus/']) {
      writeFileSync(gitignore(), `node_modules\n${entry}\n`);
      ensureProjectGitignore(root);
      expect(readFileSync(gitignore(), 'utf8')).toBe(`node_modules\n${entry}\n`);
    }
  });
});

describe('global registry', () => {
  // Isolate HOME so the test never touches the real ~/.horus/registry.json.
  let home: string;
  const ORIG_HOME = process.env['HOME'];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'horus-home-'));
    process.env['HOME'] = home;
  });
  afterEach(() => {
    if (ORIG_HOME === undefined) delete process.env['HOME'];
    else process.env['HOME'] = ORIG_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('registers and looks up a project', () => {
    expect(readRegistry().projects).toEqual({});
    registerProject('my-proj', '/repos/my-proj', '/repos/my-proj/.horus/config.json');
    const entry = lookupProject('my-proj');
    expect(entry?.root).toBe('/repos/my-proj');
    expect(entry?.configPath).toBe('/repos/my-proj/.horus/config.json');
    expect(lookupProject('nope')).toBeNull();
  });

  it('upserts an existing project entry', () => {
    registerProject('p', '/old', '/old/.horus/config.json');
    registerProject('p', '/new', '/new/.horus/config.json');
    expect(lookupProject('p')?.root).toBe('/new');
    expect(Object.keys(readRegistry().projects)).toEqual(['p']);
  });
});

describe('local secrets (HOR-212)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-secrets-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes the secret to secrets.local.json and gitignores it', () => {
    const p = writeLocalSecrets(root, { anthropic: { apiKey: 'sk-ant-SECRET' } });
    expect(p).toBe(join(root, '.horus', 'secrets.local.json'));
    expect(readLocalSecrets(root).anthropic?.apiKey).toBe('sk-ant-SECRET');
    // The gitignore explicitly lists the secrets file.
    const gi = readFileSync(join(root, '.horus', '.gitignore'), 'utf8');
    expect(gi).toContain('secrets.local.json');
  });

  it('returns {} when no secrets file exists', () => {
    expect(readLocalSecrets(root)).toEqual({});
  });

  it('does not duplicate the gitignore entry on rewrite', () => {
    writeLocalSecrets(root, { anthropic: { apiKey: 'a' } });
    writeLocalSecrets(root, { anthropic: { apiKey: 'b' } });
    const gi = readFileSync(join(root, '.horus', '.gitignore'), 'utf8');
    expect(gi.split('\n').filter((l) => l.trim() === 'secrets.local.json')).toHaveLength(1);
    expect(readLocalSecrets(root).anthropic?.apiKey).toBe('b');
  });
});


describe('registry safety (dogfood finding 6 — registered projects vanished)', () => {
  // Isolate HOME — an earlier version of this suite wrote a CORRUPT registry into
  // the real ~/.horus/registry.json. Every registry test must run in a sandbox.
  let home: string;
  const ORIG_HOME = process.env['HOME'];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'horus-home-'));
    process.env['HOME'] = home;
  });
  afterEach(() => {
    if (ORIG_HOME === undefined) delete process.env['HOME'];
    else process.env['HOME'] = ORIG_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('GUARD: registryPath resolves inside the sandbox, never the real home', () => {
    // If this fails, every test below would be mutating the user's real registry.
    expect(registryPath().startsWith(home)).toBe(true);
    expect(registryPath().startsWith(ORIG_HOME ?? '/nonexistent')).toBe(false);
  });

  it('registerProject never clobbers a corrupt registry', () => {
    const p = registryPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{ this is not json');

    const ok = registerProject('new-proj', '/repos/new', '/repos/new/.horus/config.json');
    expect(ok).toBe(false);
    // The corrupt file is preserved byte-for-byte for recovery — not replaced
    // with a fresh registry containing only the new project.
    expect(readFileSync(p, 'utf8')).toBe('{ this is not json');
  });

  it('registerProject is strictly additive on a healthy registry', () => {
    rmSync(registryPath(), { force: true }); // start clean (prior test leaves a corrupt file)
    registerProject('proj-a', '/repos/a', '/repos/a/.horus/config.json');
    registerProject('proj-b', '/repos/b', '/repos/b/.horus/config.json');
    const reg = readRegistry();
    expect(Object.keys(reg.projects).sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('writeRegistry leaves no tmp file behind (atomic rename)', () => {
    registerProject('proj-c', '/repos/c', '/repos/c/.horus/config.json');
    const dir = dirname(registryPath());
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
