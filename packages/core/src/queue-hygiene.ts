/**
 * The ONE queue-edge hygiene module.
 *
 * The stitcher's content-search extraction can pick up queue-name look-alikes from
 * test fixtures, template placeholders and malformed multiline code fragments
 * (dogfood on this repo: `<name>`, `name`, multiline `new Queue(` snippets,
 * `SEED_PRODUCTS`, `emails`, `reports`). Every consumer of `queue_edges` — the
 * engine's architecture view, `horus queues`, and the stitcher's own write path —
 * filters through here so a garbage edge can never be stored or rendered twice.
 *
 * Rules (in order):
 *  1. Name plausibility — reject empty/oversized names and anything containing
 *     whitespace or template/code characters (`<>`, `{}`, `$`, quotes, parens…).
 *  2. Fixture-only edges — when file evidence exists, drop edges whose producer AND
 *     worker both live outside product code (via the shared `isProductPath`
 *     classifier, which also catches co-located `*.test.ts` and `__fixtures__`).
 *  3. Generic-with-no-files — a bare generic word (`name`, `emails`, `jobs`, …)
 *     with zero file evidence is fixture/template residue, not a queue.
 *  4. Generic-without-a-real-worker (group level) — a generic group is extraction
 *     residue — e.g. the stitcher's own `X_QUEUE_NAME` literals self-matching —
 *     even when a file is product code, UNLESS a real worker vouches for it. A
 *     real worker is a NAMED symbol (a function/method registration like
 *     maison-safqa's `runSeedProductsForBullMq` — worker-only, enum-registered,
 *     and REAL) in a product file. A module-level string match (worker symbol ==
 *     the file stem — dogfood: this repo's own queue-hygiene stoplist literal
 *     registering as queue "SEED_PRODUCTS"'s worker) or a test-file worker
 *     cannot vouch.
 */

import { isProductPath } from './path-classify.js';

/**
 * Bare generic words that only ever name a REAL queue alongside file evidence —
 * as fixture/template residue with no product file behind them they are noise
 * (dogfood: `name`, `ALPHA`, `SEED_PRODUCTS`, `emails`, `reports`).
 */
export const GENERIC_QUEUE_NAMES: ReadonlySet<string> = new Set([
  'name', 'queue', 'queues', 'test', 'example', 'sample', 'demo', 'default',
  'data', 'items', 'jobs', 'events', 'messages', 'tasks', 'emails', 'reports',
  'alpha', 'beta', 'seed', 'seed_products',
]);

/** True when `name` is a bare generic word (case-insensitive). */
export function isGenericQueueName(name: string): boolean {
  return GENERIC_QUEUE_NAMES.has(name.toLowerCase());
}

/**
 * Plausible queue identifier: non-empty, bounded, no whitespace and no
 * template/code characters. `{}` / `$` / `<>` reject template placeholders
 * (`{name}`, `${...}`, `<name>`); `\s` rejects multiline code fragments and
 * anything with embedded whitespace.
 */
export function isPlausibleQueueName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && !/[\s<>{}()`"';$]/.test(name);
}

/** The producer/worker fields hygiene needs — matches `QueueEdge`/`NewQueueEdge`. */
export interface QueueEdgeLike {
  queueName: string;
  producerSymbol?: string | null;
  producerFile?: string | null;
  workerSymbol?: string | null;
  workerFile?: string | null;
}

/**
 * Fixture-only edge: every file behind it is non-product code, or — with no file
 * evidence at all — its name is a bare generic word.
 */
export function isFixtureQueueEdge(edge: QueueEdgeLike): boolean {
  const files = [edge.producerFile, edge.workerFile].filter(
    (f): f is string => f != null && f !== '',
  );
  if (files.length > 0) return files.every((f) => !isProductPath(f));
  return isGenericQueueName(edge.queueName);
}

/** Edge-level keep/drop: plausible name AND not fixture-only. */
export function shouldKeepQueueEdge(edge: QueueEdgeLike): boolean {
  return isPlausibleQueueName(edge.queueName) && !isFixtureQueueEdge(edge);
}

/**
 * A worker that can VOUCH for a generic queue name: a named symbol in a product
 * file. A module-level string match (the "worker" is just the file — symbol equals
 * the file's basename/stem, or is itself file-shaped like `extract.ts`) is a bare
 * literal the extractor grazed, not consuming code; a test-file worker is fixture.
 */
function isRealWorkerEvidence(edge: QueueEdgeLike): boolean {
  const sym = edge.workerSymbol;
  if (sym == null || sym === '') return false;
  const file = edge.workerFile;
  if (file != null && file !== '') {
    if (!isProductPath(file)) return false;
    const base = file.split('/').pop() ?? file;
    const stem = base.replace(/\.[^.]+$/, '');
    // Symbol == file name (with extension) is always a module-level match. Symbol ==
    // file STEM is one only when the stem cannot be a code identifier (kebab-case
    // `queue-hygiene`) — a class/function legitimately named like its file
    // (`EmailWorker` in EmailWorker.ts) is real consuming code.
    if (sym === base) return false;
    if (sym === stem && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(stem)) return false;
  }
  return !/\.[a-z]{1,4}$/i.test(sym); // file-shaped symbol name
}

/**
 * Filter a set of queue edges down to production-believable ones. Applies the
 * edge-level rules, then the group-level rule: a GENERIC queue name survives only
 * when a real worker (named symbol in product code) vouches for it somewhere in
 * the group — module-level literals and test-file workers cannot.
 */
export function filterQueueEdges<T extends QueueEdgeLike>(edges: T[]): T[] {
  const kept = edges.filter(shouldKeepQueueEdge);
  const hasRealWorker = new Set<string>();
  for (const e of kept) {
    if (isRealWorkerEvidence(e)) hasRealWorker.add(e.queueName);
  }
  return kept.filter(
    (e) => !isGenericQueueName(e.queueName) || hasRealWorker.has(e.queueName),
  );
}
