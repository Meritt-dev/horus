/**
 * Project-landscape knowledge builder (HOR-293).
 *
 * The first-version `horus init` knowledge pass: derive a `RepositoryProfile`
 * for each repo from its dependency manifest (frameworks, languages, state
 * management, auth, data sources, integrations, scripts) — local-first, no
 * source-intelligence or network required. This is the "project landscape /
 * repo roles" scope bullet; deeper extraction (GraphQL/REST contracts, types,
 * data flows) layers on top later and fills the other snapshot categories.
 *
 * Both Node (`package.json`) and Python (`pyproject.toml` / `setup.cfg` /
 * `setup.py` / `requirements.txt`) repos are supported. setup.py's
 * `install_requires` is parsed best-effort (HOR-418) and requirements.txt is
 * read as a flat dependency list (HOR-419). Provenance only ever cites a
 * manifest that actually exists on disk — never a phantom `package.json`
 * (HOR-407) — and only claims high-confidence "parsed" against a manifest whose
 * dependencies were actually extracted; otherwise it omits the filePath and
 * downgrades confidence rather than lie (HOR-418). A Python repo's dependencies
 * are mapped onto the same framework/datasource/integration tables so its
 * knowledge base is not left empty (HOR-408).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KnowledgeSnapshotSchema,
  KNOWLEDGE_SCHEMA_VERSION,
  type Confidence,
  type KnowledgeSnapshot,
  type Provenance,
} from '../schema.js';
import {
  buildKnowledgeFromSourceGraph,
  deriveExternalIntegrations,
  type SourceGraphExtract,
} from './source-graph.js';

interface PackageJson {
  name?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** Read + parse a repo's package.json, or null if absent/unreadable. */
export function readPackageJson(repoPath: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** Read a UTF-8 file relative to the repo, or null if absent/unreadable. */
function readText(repoPath: string, file: string): string | null {
  try {
    return readFileSync(join(repoPath, file), 'utf8');
  } catch {
    return null;
  }
}

// ── JS/TS detection tables (dependency-name → label) ─────────────────────────
const FRAMEWORKS: Record<string, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  '@angular/core': 'Angular',
  svelte: 'Svelte',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  koa: 'Koa',
  'type-graphql': 'TypeGraphQL',
  '@apollo/server': 'Apollo Server',
  graphql: 'GraphQL',
  commander: 'Commander (CLI)',
};
const STATE: Record<string, string> = {
  redux: 'Redux',
  '@reduxjs/toolkit': 'Redux Toolkit',
  zustand: 'Zustand',
  jotai: 'Jotai',
  recoil: 'Recoil',
  pinia: 'Pinia',
  '@tanstack/react-query': 'React Query',
  '@apollo/client': 'Apollo Client',
};
const AUTH: Record<string, string> = {
  jsonwebtoken: 'JWT',
  passport: 'Passport',
  '@clerk/nextjs': 'Clerk',
  '@clerk/clerk-sdk-node': 'Clerk',
  'next-auth': 'NextAuth',
  firebase: 'Firebase Auth',
  'firebase-admin': 'Firebase Admin',
};
const DATA_SOURCES: Record<string, string> = {
  pg: 'PostgreSQL',
  postgres: 'PostgreSQL',
  'drizzle-orm': 'Drizzle (SQL)',
  mongoose: 'MongoDB',
  mongodb: 'MongoDB',
  '@prisma/client': 'Prisma',
  typeorm: 'TypeORM',
  redis: 'Redis',
  ioredis: 'Redis',
  '@elastic/elasticsearch': 'Elasticsearch',
};
const INTEGRATIONS: Record<string, string> = {
  stripe: 'Stripe',
  shopify: 'Shopify',
  '@shopify/shopify-api': 'Shopify',
  openai: 'OpenAI',
  '@anthropic-ai/sdk': 'Anthropic',
  '@aws-sdk/client-s3': 'AWS S3',
  twilio: 'Twilio',
  resend: 'Resend',
};

// ── Python detection tables (PEP 503-normalized dep name → label) ────────────
// Keys are normalized (lowercase; runs of `-`, `_`, `.` collapsed to `-`) so
// they match the output of pkgName(); see normalizing in readPythonManifest().
const PY_FRAMEWORKS: Record<string, string> = {
  fastapi: 'FastAPI',
  django: 'Django',
  flask: 'Flask',
  starlette: 'Starlette',
  sanic: 'Sanic',
  tornado: 'Tornado',
  aiohttp: 'aiohttp',
  // task/job queues — no dedicated profile field, surfaced as frameworks.
  celery: 'Celery (queue)',
  dramatiq: 'Dramatiq (queue)',
  rq: 'RQ (queue)',
  arq: 'arq (queue)',
};
const PY_STATE: Record<string, string> = {
  redis: 'Redis',
};
const PY_AUTH: Record<string, string> = {
  pyjwt: 'JWT',
  'python-jose': 'JWT',
  authlib: 'Authlib',
};
const PY_DATA_SOURCES: Record<string, string> = {
  sqlalchemy: 'SQLAlchemy',
  'tortoise-orm': 'Tortoise ORM',
  peewee: 'Peewee',
  psycopg: 'PostgreSQL',
  psycopg2: 'PostgreSQL',
  'psycopg2-binary': 'PostgreSQL',
  asyncpg: 'PostgreSQL',
  pymongo: 'MongoDB',
  motor: 'MongoDB',
};
const PY_INTEGRATIONS: Record<string, string> = {
  boto3: 'AWS',
  stripe: 'Stripe',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  sendgrid: 'SendGrid',
};

/** Map a list of dependency names through a label table (deduped, order-stable). */
function detectNames(table: Record<string, string>, names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const label = table[name];
    if (label) out.add(label);
  }
  return [...out];
}

/** Merge several label lists, preserving first-seen order and de-duping. */
function mergeLabels(...lists: string[][]): string[] {
  const out = new Set<string>();
  for (const list of lists) for (const label of list) out.add(label);
  return [...out];
}

// ── Python manifest parsing ──────────────────────────────────────────────────

/** Strip a trailing `# comment` that is not inside a quoted string (best-effort). */
function stripTomlComment(line: string): string {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Reduce a PEP 508 requirement string (or a bare dependency name) to its
 * PEP 503-normalized project name: drop env markers / URLs / extras / version
 * specifiers, lowercase, and collapse runs of `-`, `_`, `.` to a single `-`.
 */
function pkgName(spec: string): string {
  let s = spec.trim();
  if (!s) return '';
  s = s.split(';')[0] ?? s; // environment markers
  s = s.split('@')[0] ?? s; // PEP 508 direct-reference URLs (`name @ url`)
  s = s.replace(/\[[^\]]*\]/g, ''); // extras, e.g. fastapi[all]
  const m = /^[A-Za-z0-9._-]+/.exec(s)?.[0];
  if (!m) return '';
  return m.toLowerCase().replace(/[-_.]+/g, '-');
}

interface PythonManifest {
  deps: string[];
  name?: string;
  description?: string;
}

/** Parse `[project].dependencies` (PEP 621) and Poetry dependency tables. */
function parsePyproject(text: string): PythonManifest {
  const deps: string[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let section = '';
  let inProjectDeps = false;

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = stripTomlComment(raw).trim();
    if (!trimmed) continue;

    const sec = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (sec?.[1]) {
      section = sec[1].trim();
      inProjectDeps = false;
      continue;
    }

    const quoted = (s: string): string[] =>
      (s.match(/["']([^"']+)["']/g) ?? []).map((q) => q.slice(1, -1));
    // The array terminates on a `]` that is NOT inside a quoted requirement
    // string (e.g. the `]` in `sqlalchemy[asyncio]` must not end the array).
    const closesArray = (s: string): boolean => s.replace(/["'][^"']*["']/g, '').includes(']');

    if (section === 'project') {
      const nameM = trimmed.match(/^name\s*=\s*["']([^"']+)["']/);
      if (nameM) {
        name ??= nameM[1];
        continue;
      }
      const descM = trimmed.match(/^description\s*=\s*["']([^"']*)["']/);
      if (descM) {
        description ??= descM[1];
        continue;
      }
      if (/^dependencies\s*=\s*\[/.test(trimmed)) {
        const rest = trimmed.slice(trimmed.indexOf('['));
        deps.push(...quoted(rest));
        inProjectDeps = !closesArray(rest);
        continue;
      }
      if (inProjectDeps) {
        deps.push(...quoted(trimmed));
        if (closesArray(trimmed)) inProjectDeps = false;
        continue;
      }
    }

    if (section === 'tool.poetry') {
      const nameM = trimmed.match(/^name\s*=\s*["']([^"']+)["']/);
      if (nameM) name ??= nameM[1];
      const descM = trimmed.match(/^description\s*=\s*["']([^"']*)["']/);
      if (descM) description ??= descM[1];
      continue;
    }

    if (
      section === 'tool.poetry.dependencies' ||
      section === 'tool.poetry.dev-dependencies' ||
      /^tool\.poetry\.group\..+\.dependencies$/.test(section)
    ) {
      const kv = /^([A-Za-z0-9._-]+)\s*=/.exec(trimmed)?.[1];
      if (kv && kv.toLowerCase() !== 'python') deps.push(kv);
      continue;
    }
  }

  return { deps: deps.map(pkgName).filter(Boolean), name, description };
}

/** Parse `install_requires` and `[metadata]` from a setup.cfg. */
function parseSetupCfg(text: string): PythonManifest {
  const deps: string[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let section = '';
  let inInstallRequires = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    const sec = /^\[([^\]]+)\]\s*$/.exec(trimmed)?.[1];
    if (sec) {
      section = sec.trim();
      inInstallRequires = false;
      continue;
    }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    // Indented continuation lines belong to the active multi-line value.
    if (inInstallRequires && /^\s/.test(line)) {
      deps.push(trimmed);
      continue;
    }
    inInstallRequires = false;

    if (section === 'metadata') {
      const nameM = /^name\s*=\s*(.+)$/.exec(trimmed)?.[1];
      if (nameM) name ??= nameM.trim();
      const descM = /^description\s*=\s*(.+)$/.exec(trimmed)?.[1];
      if (descM) description ??= descM.trim();
      continue;
    }
    if (section === 'options') {
      const ir = /^install_requires\s*=\s*(.*)$/.exec(trimmed)?.[1];
      if (ir !== undefined) {
        inInstallRequires = true;
        if (ir.trim()) deps.push(ir.trim()); // rare same-line single dep
      }
    }
  }

  return { deps: deps.map(pkgName).filter(Boolean), name, description };
}

/**
 * Best-effort parse of a setup.py's `install_requires=[...]` list (HOR-418).
 * setup.py is arbitrary Python, so this is intentionally narrow: it grabs the
 * first `install_requires = [ ... ]` literal array and extracts the quoted
 * requirement strings. Dynamically-computed dependency lists (e.g. built from a
 * variable or read from a file) yield nothing — the caller treats an empty
 * result as "not parsed" and refuses to stamp high-confidence provenance.
 */
function parseSetupPy(text: string): PythonManifest {
  const deps: string[] = [];
  const open = /install_requires\s*=\s*\[/.exec(text);
  if (open) {
    // Scan the array literal quote-aware so a `]` inside a requirement string
    // (e.g. "sqlalchemy[asyncio]") doesn't prematurely terminate the array.
    let depth = 1;
    let inStr = false;
    let quote = '';
    let cur = '';
    for (let i = open.index + open[0].length; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (inStr) {
        if (c === quote) {
          inStr = false;
          deps.push(cur);
        } else {
          cur += c;
        }
      } else if (c === '"' || c === "'") {
        inStr = true;
        quote = c;
        cur = '';
      } else if (c === '[') {
        depth++;
      } else if (c === ']') {
        depth--;
      }
    }
  }
  return { deps: deps.map(pkgName).filter(Boolean) };
}

/**
 * Parse a requirements.txt as a flat dependency list (HOR-419): one requirement
 * per line, skipping blanks, `#` comments, and pip directives / option flags
 * (`-r other.txt`, `-e .`, `--hash=...`). Each kept line is normalized via
 * pkgName(), which also drops inline comments and version/extras specifiers.
 */
function parseRequirementsTxt(text: string): PythonManifest {
  const deps: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    deps.push(line);
  }
  return { deps: deps.map(pkgName).filter(Boolean) };
}

interface ManifestSet {
  pkg: PackageJson | null;
  hasPackageJson: boolean;
  python: PythonManifest;
  hasPython: boolean;
  /** The single manifest file to cite as provenance, if any exists. */
  filePath?: string;
  /**
   * Confidence for the provenance stamp. 'high' when the cited manifest's
   * contents were genuinely parsed; downgraded to 'low' when a Python manifest
   * exists but none of them yielded extractable dependencies (e.g. a setup.py
   * that builds install_requires dynamically) — in that case filePath is also
   * omitted so we never claim a high-confidence parse against an unread file
   * (HOR-418).
   */
  confidence: Confidence;
}

/** Read every dependency manifest present in a repo (Node + Python). */
function readManifests(repoPath: string): ManifestSet {
  const pkg = readPackageJson(repoPath);
  const hasPackageJson = pkg !== null;

  const pyprojectText = readText(repoPath, 'pyproject.toml');
  const setupCfgText = readText(repoPath, 'setup.cfg');
  const setupPyText = readText(repoPath, 'setup.py');
  const requirementsText = readText(repoPath, 'requirements.txt');

  const python: PythonManifest = { deps: [] };
  // Track which Python manifests actually produced parseable content, so the
  // provenance only cites — at high confidence — a file we genuinely parsed.
  const parsed = new Set<string>();
  const absorb = (file: string, m: PythonManifest) => {
    python.deps.push(...m.deps);
    python.name ??= m.name;
    python.description ??= m.description;
    if (m.deps.length > 0 || m.name !== undefined || m.description !== undefined) {
      parsed.add(file);
    }
  };
  if (pyprojectText !== null) absorb('pyproject.toml', parsePyproject(pyprojectText));
  if (setupCfgText !== null) absorb('setup.cfg', parseSetupCfg(setupCfgText));
  if (setupPyText !== null) absorb('setup.py', parseSetupPy(setupPyText));
  if (requirementsText !== null) absorb('requirements.txt', parseRequirementsTxt(requirementsText));

  const hasPython =
    pyprojectText !== null ||
    setupCfgText !== null ||
    setupPyText !== null ||
    requirementsText !== null;

  // Cite only a manifest that actually exists (HOR-407). package.json wins for
  // mixed repos; otherwise fall back to the first Python manifest we genuinely
  // parsed. If a Python manifest exists but none parsed, cite nothing and
  // downgrade confidence rather than claim a high-confidence parse (HOR-418).
  const pyChain = ['pyproject.toml', 'setup.cfg', 'setup.py', 'requirements.txt'];
  let filePath: string | undefined;
  let confidence: Confidence = 'high';
  if (hasPackageJson) {
    filePath = 'package.json';
  } else {
    const citedPy = pyChain.find((f) => parsed.has(f));
    if (citedPy) {
      filePath = citedPy;
    } else if (hasPython) {
      // Detected Python but extracted no dependencies — don't lie about it.
      confidence = 'low';
    }
  }

  return { pkg, hasPackageJson, python, hasPython, filePath, confidence };
}

/**
 * Languages a repo is written in, derived strictly from manifests that exist.
 * JS/TS are only claimed when a real package.json is present (HOR-407); Python
 * when any Python manifest is present. A repo with no manifest gets `[]`.
 */
function detectLanguages(manifests: ManifestSet, jsDeps: Record<string, string>): string[] {
  const langs = new Set<string>();
  if (manifests.hasPackageJson) {
    if ('typescript' in jsDeps || Object.keys(jsDeps).some((d) => d.startsWith('@types/'))) {
      langs.add('TypeScript');
    } else {
      langs.add('JavaScript');
    }
  }
  if (manifests.hasPython) langs.add('Python');
  return [...langs];
}

function inferRole(frameworks: string[], dataSources: string[]): string | undefined {
  const fe = ['React', 'Next.js', 'Vue', 'Nuxt', 'Angular', 'Svelte'];
  const be = [
    'Express',
    'Fastify',
    'NestJS',
    'Koa',
    'TypeGraphQL',
    'Apollo Server',
    // Python web frameworks.
    'FastAPI',
    'Django',
    'Flask',
    'Starlette',
    'Sanic',
    'Tornado',
    'aiohttp',
  ];
  const hasFe = frameworks.some((f) => fe.includes(f));
  const hasBe = frameworks.some((f) => be.includes(f));
  if (frameworks.includes('Commander (CLI)')) return 'cli';
  if (hasFe && hasBe) return 'fullstack';
  if (hasFe) return 'frontend';
  if (hasBe || dataSources.length > 0) return 'backend';
  return undefined;
}

const SCRIPT_KEYS = ['start', 'dev', 'build', 'test', 'lint', 'migrate'];

export interface RepoInput {
  name: string;
  path: string;
}

export interface BuildOptions {
  project?: string;
  /** HEAD commit the snapshot is built at (recorded on provenance). */
  gitSha?: string;
  /** ISO timestamp for the snapshot (defaults to now). */
  now?: string;
  /**
   * Source-intelligence graph pulled from the analysed repo (HOR-408). When
   * present, its symbols/communities/processes populate the operations, types,
   * enums, domainConcepts, dataFlows, and runtimeComponents categories — the
   * rich analyse output the manifest-only pass used to drop. The host serves a
   * single repo, so `repo` should name it (else the lone repo is assumed).
   */
  sourceGraph?: SourceGraphExtract;
}

/** Derive a single repository profile from its dependency manifest(s). */
export function deriveRepositoryProfile(repo: RepoInput, opts: BuildOptions = {}) {
  const manifests = readManifests(repo.path);
  const pkg = manifests.pkg ?? {};
  const jsDeps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  const jsNames = Object.keys(jsDeps);
  const pyNames = manifests.python.deps;

  const frameworks = mergeLabels(
    detectNames(FRAMEWORKS, jsNames),
    detectNames(PY_FRAMEWORKS, pyNames),
  );
  const dataSources = mergeLabels(
    detectNames(DATA_SOURCES, jsNames),
    detectNames(PY_DATA_SOURCES, pyNames),
  );
  const stateManagement = mergeLabels(
    detectNames(STATE, jsNames),
    detectNames(PY_STATE, pyNames),
  );
  const auth = mergeLabels(detectNames(AUTH, jsNames), detectNames(PY_AUTH, pyNames));
  const integrations = mergeLabels(
    detectNames(INTEGRATIONS, jsNames),
    detectNames(PY_INTEGRATIONS, pyNames),
  );

  const provenance: Provenance = {
    sourceType: 'parsed',
    confidence: manifests.confidence,
    repo: repo.name,
    // Only cite a manifest that exists; omit entirely otherwise (HOR-407).
    ...(manifests.filePath ? { filePath: manifests.filePath } : {}),
    gitSha: opts.gitSha,
    generatedAt: opts.now,
  };

  return {
    id: `repo:${repo.name}`,
    scope: opts.project
      ? { project: opts.project, repository: repo.name }
      : { repository: repo.name },
    provenance,
    key: repo.name,
    name: pkg.name ?? manifests.python.name ?? repo.name,
    path: repo.path,
    role: inferRole(frameworks, dataSources),
    summary: pkg.description ?? manifests.python.description,
    frameworks,
    languages: detectLanguages(manifests, jsDeps),
    stateManagement,
    auth,
    dataSources,
    mainScripts: SCRIPT_KEYS.filter((k) => pkg.scripts && k in pkg.scripts),
    integrations,
    deploymentNotes: [],
    importantDirectories: [],
  };
}

/**
 * Build a first-version project-knowledge snapshot (repository landscape) for one
 * or more repos. Repos with no readable manifest still get a minimal profile.
 */
export function buildProjectKnowledge(
  repos: RepoInput[],
  opts: BuildOptions = {},
): KnowledgeSnapshot {
  const now = opts.now ?? new Date().toISOString();
  const repositories = repos.map((r) => deriveRepositoryProfile(r, { ...opts, now }));

  // Bridge the analysed source graph into the symbol-derived categories (HOR-408).
  // The host serves a single repo; if the caller didn't name it, fall back to the
  // lone configured repo so items carry a repository scope.
  const graphRepo = opts.sourceGraph?.repo ?? (repos.length === 1 ? repos[0]?.name : undefined);
  const fromGraph = opts.sourceGraph
    ? buildKnowledgeFromSourceGraph(opts.sourceGraph, {
        project: opts.project,
        repo: graphRepo,
        gitSha: opts.gitSha,
        now,
      })
    : {
        operations: [],
        types: [],
        enums: [],
        domainConcepts: [],
        dataFlows: [],
        runtimeComponents: [],
      };

  return KnowledgeSnapshotSchema.parse({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: now,
    project: opts.project,
    repositories,
    operations: fromGraph.operations,
    types: fromGraph.types,
    enums: fromGraph.enums,
    domainConcepts: fromGraph.domainConcepts,
    dataFlows: fromGraph.dataFlows,
    runtimeComponents: fromGraph.runtimeComponents,
    // External integrations come from the manifest-derived repo profiles — the
    // data sources / third-party SDKs already detected for the landscape.
    externalIntegrations: deriveExternalIntegrations(repositories),
  });
}
