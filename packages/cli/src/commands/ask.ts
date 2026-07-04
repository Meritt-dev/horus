import pc from 'picocolors';
import { openDb, getInvestigation } from '@horus/db';
import { loadConfig } from '@horus/core';
import type { Symbol, SymbolContext } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import type { CodeProvider } from '@horus/connectors';
import {
  refineInvestigation,
  renderRefined,
  refinedToJSON,
  answerQuestion,
  renderQAAnswer,
  qaToJSON,
  migrateReport,
} from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import { fetchInvestigationReportFromCloud } from '../lib/cloud/investigation-sync.js';
import { CloudError } from '../lib/cloud/api.js';
import { reportCloudError } from './context.js';

/**
 * HOR-21 / HOR-204 — ask: answer a follow-up question about a saved investigation,
 * or apply a deterministic topic-filter directive.
 *
 * Two modes, auto-detected from the input:
 *   - Q&A: "what evidence contradicts <topic>?", "what evidence is missing?",
 *     "why is confidence not higher?" → a direct answer from the saved report.
 *   - Topic filter (fallback): "queue", "retry", "ignore deployment" → a refined
 *     view scoped to that topic.
 *
 * Either way it reuses the persisted report's evidence — never re-queries source
 * intelligence or any production connector.
 */
function renderAnswer(
  report: InvestigationReport,
  directive: string,
  opts: { json?: boolean },
): number {
  const answer = answerQuestion(report, directive);
  if (answer) {
    console.log(opts.json ? qaToJSON(answer) : renderQAAnswer(answer));
    return 0;
  }

  const v = refineInvestigation(report, directive);
  console.log(opts.json ? refinedToJSON(report, v) : renderRefined(report, v));

  if (!opts.json && report.aiJudgment) {
    const j = report.aiJudgment;
    console.log('');
    console.log(pc.dim('─'.repeat(60)));
    console.log(pc.dim(`Stored AI judgment (${j.provider}, ${j.generatedAt}):`));
    if (j.rootCauseAssessment) {
      console.log(pc.bold('Root cause (AI):'), j.rootCauseAssessment.summary);
      console.log(pc.dim(`Uncertainty: ${j.rootCauseAssessment.uncertainty}`));
    } else {
      console.log(pc.bold('AI Why:'), j.why);
    }
  }
  return 0;
}

/** Classified result of a local-DB investigation lookup. */
type LocalLookup =
  | { kind: 'found'; report: InvestigationReport }
  | { kind: 'not-found' }
  | { kind: 'no-report' }
  | { kind: 'error'; message: string };

/**
 * Look up a locally-persisted investigation report by id. `engine.investigate()` always
 * persists the report to the local DB, and the id `investigate` prints as its header
 * (`# Investigation <id>`) is this local id — so the local store is the right first stop.
 */
async function lookupLocalInvestigation(id: string, configPath?: string): Promise<LocalLookup> {
  const { db, sql } = await openDb();
  try {
    const row = await getInvestigation(db, id);
    if (!row) return { kind: 'not-found' };
    if (!row.report) return { kind: 'no-report' };
    return { kind: 'found', report: migrateReport(row.report) as InvestigationReport };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined;
    // 22P02 = invalid uuid text → not a local id; let the caller try cloud / report not-found.
    if (code === '22P02') return { kind: 'not-found' };
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// HOR-331 — fresh source lookup for code-locating questions
// ---------------------------------------------------------------------------

/**
 * Phrases that signal a "where/how does this code live" question, as opposed to a
 * question about the saved investigation's reasoning ("why is confidence low?").
 */
const CODE_LOCATING_PHRASES: readonly RegExp[] = [
  /\bwhere\b.*\b(is|are|does|do|can\s+i\s+find|defined|declared|implemented|located|live[s]?)\b/i,
  /\b(which|what)\s+file\b/i,
  /\bhow\s+is\b.+\b(defined|implemented|declared|structured)\b/i,
  /\bfind\b.*\b(definition|symbol|function|class|method|file)\b/i,
  /\blocate\b/i,
];

/** Strip surrounding punctuation that clings to a word (`processOrder?` → `processOrder`). */
function cleanToken(t: string): string {
  return t.replace(/[?.,!:;'"()]+$/g, '').replace(/^[?.,!:;'"]+/g, '');
}

/**
 * Heuristic: does `raw` look like a code identifier (camelCase, PascalCase, snake_case,
 * or a `foo()` call) rather than an ordinary English word?
 */
function looksLikeSymbol(raw: string): boolean {
  const t = raw.replace(/[?.,!:;]+$/g, '');
  if (/\w\(\)$/.test(t)) return true; // foo()
  const w = t.replace(/[()'"]/g, '');
  if (w.length < 2) return false;
  if (/[a-z][A-Z]/.test(w)) return true; // camelCase / PascalCase boundary
  if (/^[A-Z][a-zA-Z0-9]*[A-Z]/.test(w)) return true; // PascalCase (two+ caps)
  if (/^[a-zA-Z]\w*_\w+$/.test(w)) return true; // snake_case
  return false;
}

/**
 * HOR-331 — Classify a question as "code-locating": one that asks WHERE/HOW code lives
 * (e.g. "where is X", "which file", "how is X defined") or that simply names a symbol-like
 * token. These deserve a fresh source lookup rather than a replay of saved evidence.
 */
export function isCodeLocatingQuestion(directive: string): boolean {
  const q = directive.trim();
  if (!q) return false;
  if (CODE_LOCATING_PHRASES.some((re) => re.test(q))) return true;
  return q.split(/\s+/).some(looksLikeSymbol);
}

const LOCATE_STOPWORDS = new Set<string>([
  'where', 'is', 'are', 'was', 'were', 'does', 'do', 'did', 'has', 'have', 'the', 'a',
  'an', 'how', 'which', 'what', 'file', 'files', 'defined', 'define', 'declared',
  'implemented', 'located', 'find', 'locate', 'can', 'i', 'in', 'code', 'to', 'of',
  'for', 'that', 'this', 'it', 'function', 'class', 'method', 'symbol', 'definition',
]);

/**
 * Reduce a natural-language question to the best query string for `searchSymbols`:
 * prefer the symbol-like tokens, otherwise drop locate/stopwords and keep the remainder.
 */
export function extractSymbolQuery(directive: string): string {
  const rawTokens = directive.split(/\s+/).filter(Boolean);
  const symbols = rawTokens.filter(looksLikeSymbol).map(cleanToken).filter(Boolean);
  if (symbols.length > 0) return symbols.join(' ');
  const rest = rawTokens
    .map(cleanToken)
    .filter((t) => t && !LOCATE_STOPWORDS.has(t.toLowerCase()));
  return rest.join(' ') || directive.trim();
}

/** Render a symbol's `file:line` (or `file:start-end`) citation. */
function symbolLocation(s: { filePath: string; startLine?: number; endLine?: number }): string {
  let loc = s.filePath;
  if (s.startLine) {
    loc += ':' + s.startLine;
    if (s.endLine && s.endLine !== s.startLine) loc += '-' + s.endLine;
  }
  return loc;
}

function codeAnswerToJSON(
  directive: string,
  query: string,
  symbols: Symbol[],
  ctx: SymbolContext | null,
): unknown {
  return {
    question: directive,
    query,
    source: 'source-host',
    matches: symbols.map((s) => ({
      name: s.name,
      location: symbolLocation(s),
      filePath: s.filePath,
      startLine: s.startLine,
      endLine: s.endLine,
      signature: s.signature,
    })),
    snippet: ctx?.snippet,
  };
}

function renderCodeAnswer(directive: string, symbols: Symbol[], ctx: SymbolContext | null): void {
  const top = symbols[0];
  if (!top) return;
  console.log('');
  console.log(pc.bold(directive));
  console.log(`  ${pc.green('→')} ${pc.bold(top.name)}  ${pc.dim(symbolLocation(top))}`);
  if (top.signature) console.log(`    ${pc.dim(top.signature)}`);
  if (ctx?.snippet) {
    for (const line of ctx.snippet.split('\n').slice(0, 3)) {
      console.log(pc.dim('    ' + line));
    }
  }
  const others = symbols.slice(1);
  if (others.length > 0) {
    console.log('');
    console.log(pc.dim('  Other matches:'));
    for (const s of others) {
      console.log(`    - ${s.name}  ${pc.dim(symbolLocation(s))}`);
    }
  }
  console.log('');
  console.log(pc.dim('  (fresh source lookup — re-queried the source host)'));
}

/**
 * HOR-331 — Answer a code-locating question by issuing a NEW lookup against the
 * source-intelligence host (`searchSymbols` + `context`), with file:line citations —
 * instead of re-printing saved evidence. Returns an exit code on success, or `null`
 * when no host is configured / reachable / matched, so the caller can fall back to the
 * saved-report path.
 */
async function answerFromSource(
  directive: string,
  opts: { config?: string; json?: boolean; repo?: string },
): Promise<number | null> {
  let code: CodeProvider;
  try {
    const config = await loadConfig(opts.config);
    code = codeForRepo(config, opts.repo);
  } catch {
    return null; // no config / no source connector → fall back to saved report
  }

  let healthOk = false;
  try {
    healthOk = (await code.health()).ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) return null; // host unreachable → fall back

  const query = extractSymbolQuery(directive);
  let symbols: Symbol[];
  try {
    symbols = await code.searchSymbols(query, 5);
  } catch {
    return null;
  }
  if (!symbols || symbols.length === 0) return null; // host-miss → fall back

  const top = symbols[0];
  let ctx: SymbolContext | null = null;
  try {
    ctx = top ? await code.context(top.id) : null;
  } catch {
    ctx = null; // citations from searchSymbols are enough; context is best-effort
  }

  if (opts.json) {
    console.log(JSON.stringify(codeAnswerToJSON(directive, query, symbols, ctx), null, 2));
  } else {
    renderCodeAnswer(directive, symbols, ctx);
  }
  return 0;
}

export async function runAsk(
  id: string,
  directive: string,
  opts: { config?: string; json?: boolean; repo?: string },
): Promise<number> {
  // HOR-331: a code-locating question ("where is X", "which file", a symbol token, …)
  // deserves a FRESH answer from the source host with file:line citations — not a replay
  // of stale saved evidence. Try that first; fall back to the saved report on any miss
  // (no host configured, host unreachable, or no symbol matched).
  if (isCodeLocatingQuestion(directive)) {
    const located = await answerFromSource(directive, opts);
    if (located !== null) return located;
  }

  const repoRoot = repoRootOrCwd();
  const cloudCfg = readCloudConfig(repoRoot);

  if (isCloudActive(cloudCfg)) {
    // HOR-319 (Bug 1): the id `investigate` prints as its header is the LOCAL id, while
    // the cloud API only knows its own investigation id. Resolve LOCAL first so the most
    // visible id works, then fall back to cloud (covers cloud-only / teammate runs).
    const local = await lookupLocalInvestigation(id, opts.config);
    if (local.kind === 'found') return renderAnswer(local.report, directive, opts);

    const session = authedClient();
    if (!session) {
      console.error(
        pc.red(
          `This repo is linked to Horus Cloud but you are not logged in. Run ${pc.bold('horus login')} first.`,
        ),
      );
      return 1;
    }
    try {
      const report = await fetchInvestigationReportFromCloud(session.client, cloudCfg, id);
      if (report) return renderAnswer(report, directive, opts);
      console.error(
        pc.red(
          `Investigation ${id} has no saved report locally or in Horus Cloud. Run ${pc.bold('horus investigate')} first.`,
        ),
      );
      return 1;
    } catch (err) {
      // A 404 here just means `id` isn't a cloud id either; since local also missed,
      // give a clear not-found instead of a raw cloud error.
      if (err instanceof CloudError && err.status === 404) {
        console.error(
          pc.red(
            `No investigation found for "${id}" locally or in Horus Cloud. Use the id printed at the top of \`horus investigate\` output.`,
          ),
        );
        return 1;
      }
      return reportCloudError(err);
    }
  }

  // Local mode — resolve against the local DB only.
  const local = await lookupLocalInvestigation(id, opts.config);
  switch (local.kind) {
    case 'found':
      return renderAnswer(local.report, directive, opts);
    case 'no-report':
      console.error(pc.red('Investigation ' + id + ' has no stored report.'));
      return 1;
    case 'error':
      console.error(pc.red(local.message));
      return 1;
    case 'not-found':
    default:
      console.error(pc.red('No investigation found: ' + id));
      return 1;
  }
}
