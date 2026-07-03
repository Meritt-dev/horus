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
 *  4. Type-declaration-only edges — an edge whose EVERY file is a type-declaration
 *     file (`.d.ts`/`.d.mts`/`.d.cts` or `*.interface(s).ts`) is a shape the
 *     extractor grazed, never a producer/consumer (dogfood 0.21: kafkajs's
 *     `types/index.d.ts` and Nest's `kafka.interface.ts` fabricating queue GZIP ↔
 *     worker Snappy from a `CompressionTypes` enum). One real product file
 *     alongside a type-decl file is enough to keep the edge.
 *  5. Generic-without-a-real-worker (group level) — a generic group is extraction
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
 * A SCREAMING_SNAKE_CASE constant/enum-member name (≥2 segments) — the stitcher grazed an
 * enum key, not a queue (dogfood 0.21: Vue `GLOBAL_MOUNT`/`INSTANCE_DESTROY`/`CONFIG_DEVTOOLS`,
 * Nest compression enums). Treated like a generic name: it survives only if a REAL worker
 * (named consuming symbol in product code) vouches for it.
 */
export function isConstantShapedQueueName(name: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name);
}

/** Names that only ever denote a real queue alongside a real worker — bare generic words
 *  and enum-shaped constants. Extraction residue otherwise. */
function needsWorkerVouch(name: string): boolean {
  return isGenericQueueName(name) || isConstantShapedQueueName(name);
}

/**
 * Plausible queue identifier: non-empty, bounded, no whitespace and no
 * template/code characters. `{}` / `$` / `<>` reject template placeholders
 * (`{name}`, `${...}`, `<name>`); `\s` rejects multiline code fragments and
 * anything with embedded whitespace. A name with ≥2 dots (`bullmq.job.id`,
 * `bullmq.queue.name`) is a dotted telemetry/config attribute key, never a
 * queue identifier (dogfood 0.21: bullmq's OpenTelemetry attribute constants).
 */
export function isPlausibleQueueName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (/[\s<>{}()`"';$]/.test(name)) return false;
  if ((name.match(/\./g)?.length ?? 0) >= 2) return false;
  return true;
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

/**
 * A same-file enum/constants edge: producer and worker are two constants in ONE
 * enum/constants/attributes/telemetry module (dogfood 0.21: Nest's Kafka compression
 * enum, where "queue GZIP" had "worker Snappy" — both members of one enum). A real queue
 * has a producer and a worker in different roles, not two literals the extractor matched
 * against each other inside a constants file.
 */
function isEnumConstantEdge(edge: QueueEdgeLike): boolean {
  const pf = edge.producerFile;
  const wf = edge.workerFile;
  if (pf == null || pf === '' || pf !== wf) return false;
  const base = (pf.split('/').pop() ?? pf).toLowerCase();
  return /(enum|constant|attribute|telemetry)/.test(base);
}

/**
 * A type-declaration file: a `.d.ts`/`.d.mts`/`.d.cts` ambient-types file, or a
 * `*.interface.ts` / `*.interfaces.ts` (also `.cts`/`.mts`) declarations module.
 * Types cannot produce or consume messages, so they are never real queue evidence.
 */
function isTypeDeclarationFile(file: string): boolean {
  const base = (file.split('/').pop() ?? file).toLowerCase();
  return /\.d\.[cm]?ts$/.test(base) || /\.interfaces?\.[cm]?ts$/.test(base);
}

/**
 * A type-declaration-only edge: EVERY file behind it is a type-declaration file
 * (dogfood 0.21: kafkajs's `types/index.d.ts` and Nest's `kafka.interface.ts`
 * both fabricated queue GZIP ↔ worker Snappy from a `CompressionTypes` enum in a
 * `.d.ts`). Types declare shapes; they neither produce nor consume messages. An
 * edge with even ONE real product file alongside a type-decl file is NOT dropped.
 */
function isTypeDeclarationEdge(edge: QueueEdgeLike): boolean {
  const files = [edge.producerFile, edge.workerFile].filter(
    (f): f is string => f != null && f !== '',
  );
  if (files.length === 0) return false;
  return files.every((f) => isTypeDeclarationFile(f));
}

/** Edge-level keep/drop: plausible name, not fixture-only, not an enum-constant
 *  self-match, not a type-declaration-only edge. */
export function shouldKeepQueueEdge(edge: QueueEdgeLike): boolean {
  return (
    isPlausibleQueueName(edge.queueName) &&
    !isFixtureQueueEdge(edge) &&
    !isEnumConstantEdge(edge) &&
    !isTypeDeclarationEdge(edge)
  );
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
  // A SCREAMING_SNAKE constant is another enum member, not consuming code — it cannot
  // vouch for an enum-shaped queue name (dogfood 0.21: enum members matching each other).
  if (isConstantShapedQueueName(sym)) return false;
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
    (e) => !needsWorkerVouch(e.queueName) || hasRealWorker.has(e.queueName),
  );
}
