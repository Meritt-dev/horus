import { classifyPath, filterQueueEdges } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import { listQueueEdges, type HorusDb, type QueueEdge } from '@horus/db';

export interface Subsystem {
  name: string;
  members: number;
  /** Test/docs/maintenance-dominated (by name tokens or member paths) — rendered tagged + last. */
  testy?: boolean;
}

export interface AsyncBoundary {
  queueName: string;
  /** Producer symbols + their files — file disambiguates same-named producer/worker (HOR-368). */
  producers: { symbol: string; file: string | null }[];
  workers: { symbol: string; file: string | null }[];
}

export interface ExternalSystem {
  name: string;
  files: number;
}

export interface ArchitectureModel {
  nodeStats: { label: string; count: number }[];
  subsystems: Subsystem[];
  asyncBoundaries: AsyncBoundary[];
  keyFlows: string[];
  externalSystems: ExternalSystem[];
  fragile: { deadCode: number; highCouplingPairs: number };
  summary: string;
}

const EXTERNAL_MARKERS = [
  'zoho',
  'stripe',
  'prisma',
  'redis',
  'bullmq',
  'twilio',
  'sendgrid',
  'clerk',
  'pusher',
  'axios',
  'elasticsearch',
  'prometheus',
  'mongo',
  'graphql',
  // Python ecosystem (HOR-356): the markers above are Node-centric, so Python backends'
  // DB/queue/web stacks went undetected (e.g. redash's Postgres + Celery). 'mongo'/'redis'
  // already cover pymongo/redis-py by substring.
  'sqlalchemy',
  'sqlmodel',
  'psycopg',
  'celery',
  'fastapi',
  'flask',
  'django',
  'kafka',
  'boto3',
  // Node ORMs/DB drivers (HOR-359): markers above had only prisma/mongo/redis, so a
  // TypeORM/Sequelize/Knex backend's database layer went undetected (e.g. vendure on
  // Postgres). Names chosen to be unambiguous in file content (bare 'pg' would false-match).
  'typeorm',
  'sequelize',
  'knex',
  'drizzle-orm',
  'postgres',
  'mariadb',
  'mysql2',
  'mssql',
  // Python async DB drivers (HOR-379): the markers above missed several backends real Python
  // DB libs implement (e.g. `databases` caught sqlalchemy/postgres/psycopg but missed asyncpg,
  // aiomysql/asyncmy, aiopg, aiosqlite). Their names don't substring-match the sync drivers, so
  // they need explicit markers. 'sqlite' also covers sqlite3/aiosqlite.
  'sqlite',
  'asyncpg',
  'aiomysql',
  'asyncmy',
  'aiopg',
  'pymysql',
] as const;

/** Community-name tokens that mark a test/example/docs cluster (de-prioritized in ranking). */
const TESTY_TOKENS = new Set([
  'test', 'tests', 'spec', 'specs', 'example', 'examples', 'sample', 'samples',
  'demo', 'demos', 'docs', 'doc', 'tutorial', 'tutorials', 'fixture', 'fixtures', 'e2e',
]);

/** True when a Louvain community name is dominated by test/example/docs tokens (HOR-365). */
export function isTestyCommunity(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[+\s/_.-]+/)
    .some((t) => TESTY_TOKENS.has(t));
}

/**
 * True when most of a community's MEMBERS live under test/example/docs trees (dogfood
 * cycle-2 N4). Name tokens miss doc-derived cluster names — fastapi's
 * "Path_params_numeric_validations+Scripts" (a docs_src tutorial dir) ranked as the
 * 3rd subsystem. Member node ids are path-shaped (`<kind>:<path>:<name>`), so the
 * file path is extractable without extra requests.
 */
// Repo-maintenance trees that are never "the architecture" (fastapi's docs/translation
// scripts formed the 170-member top subsystem). Ranking-only signal — deliberately NOT
// part of isTestOrExamplePath, which also gates dead-code and external-system detection.
const MAINTENANCE_DIR_RE = /(^|\/)(scripts?|tools?|tooling|ci|\.github|hack)(\/|$)/i;

export function isMostlyNonProductMembers(members: string[] | undefined): boolean {
  if (!members || members.length === 0) return false;
  let nonProduct = 0;
  for (const id of members) {
    const parts = id.split(':');
    const path = parts.length >= 2 ? (parts[1] ?? '') : '';
    if (path !== '' && (isTestOrExamplePath(path) || MAINTENANCE_DIR_RE.test(path))) {
      nonProduct += 1;
    }
  }
  return nonProduct / members.length > 0.6;
}

/**
 * Normalize a community name on display (HOR-377). The backend's naming is fixed at the source,
 * but indexes built before that fix still carry degenerate names — clean them here so existing
 * repos benefit without a re-index: strip leading `_`/`.` ("_ext" → "ext") and collapse "X+x"
 * where both halves are the same case-insensitively ("Sqs+sqs" → "Sqs").
 */
export function cleanSubsystemName(name: string): string {
  let n = name.replace(/^[_.]+/, '').trim();
  const parts = n.split('+');
  if (parts.length === 2) {
    const [a, b] = parts;
    if (a && b && a.toLowerCase() === b.toLowerCase()) n = a;
  }
  return n || name;
}

/** A file path in a test/example/docs tree or file — excluded from external-system
 *  detection (HOR-366). Delegates to the shared classifier (@horus/core), which also
 *  catches co-located `*.test.ts` files the old directory regex missed. */
export function isTestOrExamplePath(p: string): boolean {
  const kind = classifyPath(p);
  return kind === 'test' || kind === 'docs' || kind === 'example';
}

// Word-list / dataset files are full of proper nouns and common words that collide with
// integration markers — an external system matched inside one is a coincidence, not a
// dependency (dogfood 0.21: drizzle-seed `datasets/lastNames.ts` → "kafka"/"django",
// `jobsTitles.ts` → "clerk", drizzle-kit `words.ts` → "stripe"). Excluded from
// external-system detection only (they remain product code everywhere else).
const DATA_FILE_RE =
  /(^|\/)(datasets?|seed(?:s|-?data)?|dictionar(?:y|ies)|word-?lists?|locales?|i18n|corpus)(\/|$)|(^|\/)(first-?names?|last-?names?|sur-?names?|full-?names?|countries|cities|nouns|adjectives|verbs|words|colou?rs|jobs?-?titles?|emojis?)\.[jt]sx?$/i;

/** A word-list/dataset file whose string contents falsely match integration markers. */
export function isDataFilePath(p: string): boolean {
  return DATA_FILE_RE.test(p);
}

/**
 * True when a marker's matched files are dominated by the repo's OWN plugin/capability
 * for that marker, not an integration WITH it (dogfood 0.21): prettier's
 * `src/language-graphql/*` is its GraphQL formatter, not a GraphQL dependency; a repo's
 * `packages/graphql/*` is the package it ships. Heuristic: >=50% of the marker's matched
 * product files live under a directory segment whose name contains the marker (so a repo
 * that merely IMPORTS graphql from scattered files is unaffected). Case-insensitive; the
 * marker's own non-alpha chars (e.g. `drizzle-orm`) are stripped so `drizzle`/`orm`-named
 * dirs still count.
 */
export function isOwnCapability(marker: string, productFiles: string[]): boolean {
  if (productFiles.length === 0) return false;
  const needle = marker.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (needle === '') return false;
  const inOwnDir = productFiles.filter((p) =>
    p
      .replace(/\\/g, '/')
      .toLowerCase()
      .split('/')
      .slice(0, -1)
      .some((seg) => seg.replace(/[^a-z0-9]/g, '').includes(needle)),
  ).length;
  // A repo's own capability for X lives in a directory named after X (`src/language-graphql`,
  // `src/graphql`, `packages/redis`). It may be CONCENTRATED there (≥50%) or DIFFUSE across
  // several dirs while still anchored by a real same-named module — prettier's GraphQL support
  // is only ~35% under `src/language-graphql` (the rest is in `language-js/embed`, `main/plugins`),
  // yet it is unmistakably prettier's own plugin, not a Stripe-style integration (dogfood 0.21.2).
  // Require a genuine cluster (≥2 files in a same-named dir) so a single coincidental path
  // (`src/redis/util.ts` in a repo that really talks to Redis) never suppresses a real external.
  const frac = inOwnDir / productFiles.length;
  return frac >= 0.5 || (inOwnDir >= 2 && frac >= 0.33);
}

export async function discoverArchitecture(deps: {
  code: CodeProvider;
  db: HorusDb;
  /** Active project — scopes queue edges so other projects' queues don't leak in (HOR-207). */
  project?: string;
  /** Manifest-derived package names of THIS repo (package.json/pyproject/go.mod/Cargo.toml) —
   *  excluded from external-system detection alongside the project label (dogfood N2). */
  ownPackages?: string[];
}): Promise<ArchitectureModel> {
  // NOTE: every section degrades to its empty default independently — one absent
  // provider method or failed request must not blank the whole architecture view.
  // (These used to be raw Cypher through code.cypher(); the SQLite console rejects
  // Cypher, so every section silently rendered empty — the typed methods fix that.)

  // 1. Node label counts
  const nodeStats = await (async () => {
    try {
      const o = await deps.code.overview?.();
      if (!o) return [];
      return Object.entries(o.nodesByLabel)
        .map(([label, count]) => ({ label, count: Number(count ?? 0) }))
        .filter((s) => s.label.toLowerCase() !== 'embedding')
        .sort((a, b) => b.count - a.count);
    } catch {
      return [];
    }
  })();

  // 2. Subsystems (Louvain communities)
  const subsystems = await (async () => {
    try {
      const communities = (await deps.code.communities?.()) ?? [];
      const rows = communities.map((c) => ({
        name: cleanSubsystemName(c.name),
        members: Number(c.memberCount ?? 0),
        // Name tokens (HOR-365) OR member paths (dogfood N4): docs_src/example clusters
        // carry dir-derived names no token list can enumerate.
        testy: isTestyCommunity(c.name) || isMostlyNonProductMembers(c.members),
      }));
      // De-prioritize test/example/docs clusters so the real product subsystems lead — they're
      // large but rarely what "the architecture" means. Sort AFTER mapping all rows so a real
      // subsystem ranked below the test clusters isn't dropped by the top-12 slice (HOR-365).
      rows.sort((a, b) => {
        const at = a.testy ? 1 : 0;
        const bt = b.testy ? 1 : 0;
        if (at !== bt) return at - bt;
        return b.members - a.members;
      });
      return rows.slice(0, 12);
    } catch {
      return [];
    }
  })();

  // 3. Async boundaries from queue edges
  const asyncBoundaries = await (async () => {
    try {
      const rawEdges: QueueEdge[] = await listQueueEdges(deps.db, { project: deps.project });
      // Hygiene (dogfood): the stitcher can pick up queue-name look-alikes from test
      // fixtures, template placeholders and malformed multiline code fragments. Product
      // architecture shows PRODUCT boundaries. The canonical rules live in
      // @horus/core's queue-hygiene module (shared with `horus queues` and the
      // stitcher's write path): implausible names, fixture-only edges, bare generic
      // names without file evidence, and producer-only-generic groups all drop here.
      const edges = filterQueueEdges(rawEdges);
      type SymFile = { symbol: string; file: string | null };
      const byQueue = new Map<string, { producers: Map<string, SymFile>; workers: Map<string, SymFile> }>();
      for (const edge of edges) {
        const key = edge.queueName;
        if (!byQueue.has(key)) {
          byQueue.set(key, { producers: new Map(), workers: new Map() });
        }
        const entry = byQueue.get(key)!;
        if (edge.producerSymbol != null && edge.producerSymbol !== '') {
          const file = edge.producerFile ?? null;
          entry.producers.set(`${edge.producerSymbol}\u0000${file ?? ''}`, { symbol: edge.producerSymbol, file });
        }
        if (edge.workerSymbol != null && edge.workerSymbol !== '') {
          const file = edge.workerFile ?? null;
          entry.workers.set(`${edge.workerSymbol}\u0000${file ?? ''}`, { symbol: edge.workerSymbol, file });
        }
      }
      // Note: the producer-only-generic rule (a bare generic name is residue unless
      // some edge has a WORKER — real consuming code) is applied inside
      // filterQueueEdges above.
      return Array.from(byQueue.entries())
        .map(([queueName, { producers, workers }]) => ({
          queueName,
          producers: Array.from(producers.values()),
          workers: Array.from(workers.values()),
        }));
    } catch {
      return [];
    }
  })();

  // 4. Key flows (Process nodes) — ranked by IMPORTANCE, not alphabetically (dogfood
  //    cycle-2 N3: fastapi's "Critical paths" were 10x get_path_param_* docs_src
  //    one-liners purely because they sort first). Real-path flows lead, longer flows
  //    beat shorter ones, name only breaks ties.
  const keyFlows = await (async () => {
    try {
      const processes = (await deps.code.processes?.()) ?? [];
      const ranked = processes
        .filter((p) => p.name !== '')
        .map((p) => {
          const firstStep = p.steps?.[0]?.nodeId ?? '';
          const parts = firstStep.split(':');
          const path = parts.length >= 2 ? (parts[1] ?? '') : '';
          return {
            name: p.name,
            steps: Number(p.stepCount ?? p.steps?.length ?? 0),
            nonProduct: path !== '' && isTestOrExamplePath(path),
          };
        });
      ranked.sort((a, b) => {
        if (a.nonProduct !== b.nonProduct) return a.nonProduct ? 1 : -1;
        if (a.steps !== b.steps) return b.steps - a.steps;
        return a.name.localeCompare(b.name);
      });
      return ranked.slice(0, 20).map((p) => p.name);
    } catch {
      return [];
    }
  })();

  // 5. Fragility metrics
  const deadCode = await (async () => {
    try {
      const report = await deps.code.deadCode?.();
      return Number(report?.total ?? 0);
    } catch {
      return 0;
    }
  })();

  const highCouplingPairs = await (async () => {
    try {
      const pairs = (await deps.code.coupling?.()) ?? [];
      return pairs.filter((p) => Number(p.coChanges ?? 0) >= 3).length;
    } catch {
      return 0;
    }
  })();

  // 6. External systems — ONE per-token file search for all markers. Count only
  //    NON-test/example files so a marker mentioned once in a test or example isn't
  //    reported as a real dependency, and skip the repo's OWN package (a project named
  //    `flask` shouldn't list `flask` as external) — HOR-366.
  // Own-package candidates: the project label AND real manifest names the caller
  // detected (dogfood cycle-2 N2: the horus project name is often df-prefixed or
  // renamed — fastapi listed ITSELF as an external system because `deps.project`
  // was "df2-fastapi" while the marker matched the pyproject name "fastapi").
  const ownPackages = new Set(
    [deps.project, ...(deps.ownPackages ?? [])]
      .filter((x): x is string => typeof x === 'string' && x !== '')
      .map((x) => x.toLowerCase()),
  );
  const externalSystems = await (async () => {
    try {
      const markers = EXTERNAL_MARKERS.filter((m) => !ownPackages.has(m.toLowerCase()));
      const matches = (await deps.code.filesContaining?.(markers, 500)) ?? {};
      return markers
        .map((marker) => {
          // Count only genuine product source. `classifyPath === 'product'` additionally drops
          // config/lockfiles (a marker in `pnpm-lock.yaml`/`package.json` is a transitive dep,
          // not an integration) and vendored trees over the old test/example-only filter;
          // data files are excluded because their string contents collide with markers.
          const productFiles = (matches[marker] ?? []).filter(
            (p) => p !== '' && classifyPath(p) === 'product' && !isDataFilePath(p),
          );
          return { name: marker, files: productFiles.length, productFiles };
        })
        .filter((r) => r.files > 0 && !isOwnCapability(r.name, r.productFiles))
        .map((r) => ({ name: r.name, files: r.files }))
        .sort((a, b) => b.files - a.files);
    } catch {
      return [];
    }
  })();

  // 7. Summary sentence
  const largestSubsystem = subsystems[0];
  const largestDesc =
    largestSubsystem != null
      ? `${largestSubsystem.name} with ${largestSubsystem.members} symbols`
      : 'none';
  const summary =
    `${subsystems.length} subsystems (largest: ${largestDesc}), ` +
    `${asyncBoundaries.length} async queue boundaries, ` +
    `${externalSystems.length} external systems, ` +
    `${deadCode} unreferenced symbols.`;

  return {
    nodeStats,
    subsystems,
    asyncBoundaries,
    keyFlows,
    externalSystems,
    fragile: { deadCode, highCouplingPairs },
    summary,
  };
}
