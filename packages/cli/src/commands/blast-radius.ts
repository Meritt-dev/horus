import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { openDb } from '@horus/db';
import { analyzeBlastRadius, renderBlastRadius, blastRadiusToJSON, route, formatRouteStep } from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';
import { failCommand } from '../lib/command-failure.js';
import { printCapabilityHint } from '../lib/capability-hint.js';

/** Dim note shown when this build ships without local persistence (single-file download). */
const DB_UNAVAILABLE_NOTE =
  'local persistence unavailable in this build — async queue-boundary enrichment skipped (install via npm or Homebrew for it)';

export const BLAST_RADIUS_AI_CONTRACT = `Provide a clearly separated AI interpretation section with:

Evidence used
- The matched component(s), upstream dependencies, downstream callers, and async boundaries Horus found

Likely impact
- What users or operators would notice if this component fails
- Which services/flows are inside the blast radius and at direct risk
- Which services/flows appear outside the blast radius

Containment ideas
- Safe mitigations grounded only in the dependencies Horus found
- Rollback or disable suggestions only when supported by the evidence (prefix with "verify before doing this")
- Async boundaries to isolate (queues, workers, cron jobs, webhooks, external APIs)

Confidence
- High / Medium / Low with a one-line reason

Next checks
- Exact Horus commands or files to inspect next`;

export async function runBlastRadius(
  query: string,
  opts: {
    config?: string;
    repo?: string;
    depth?: number;
    json?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Include test/docs/example callers in the impact traversal (product-only by default). */
    includeTests?: boolean;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { code } = createConnectors(config);

    const health = await code.health();
    if (!health.ok) {
      // HOR-386 — host down: the router points at `horus init`.
      const steps = route({ command: 'blast-radius', hostUnreachable: true });
      if (opts.json) {
        console.log(JSON.stringify({ error: 'Source-intelligence host unreachable', nextSteps: steps }, null, 2));
      } else {
        console.error(pc.red('Source-intelligence host unreachable — run: horus init'));
        for (const s of steps) console.log(pc.dim('  Suggested next: ') + formatRouteStep(s));
      }
      return 1;
    }

    let project: string | undefined;
    try {
      project = resolveEnvironment(config, { project: opts.repo }).project;
    } catch {
      /* unresolvable — leave unscoped */
    }

    const { db, sql } = await openDb(config.database.url);
    try {
      const r = await analyzeBlastRadius(query, { code, db, project }, opts.depth ?? 3, {
        includeTests: opts.includeTests ?? false,
      });
      if (!r) {
        // HOR-386 — no symbol matched: the router points at `horus search <query>`.
        const steps = route({ command: 'blast-radius', empty: true, query });
        if (opts.json) {
          console.log(JSON.stringify({ symbol: null, nextSteps: steps }, null, 2));
        } else {
          console.log(`No symbol found for: ${query}`);
          console.log(pc.dim(`  Tip: use an exact class or function name, e.g. "MyService"`));
          for (const s of steps) console.log(pc.dim('  Suggested next: ') + formatRouteStep(s));
        }
        return 1;
      }
      // The shared resolver's verdict, not a raw name comparison — `Engine.Run`
      // resolving to Engine's `Run` method is an exact QUALIFIED match, and must
      // never be reported as "fuzzy closest: Run" (gin dogfood).
      const fuzzyNotice =
        r.resolution === 'fuzzy'
          ? `No exact match for "${query}" — showing closest: "${r.seed.name}" (fuzzy match)`
          : null;
      const ambiguityNotice =
        r.ambiguous && r.alternatives.length > 0
          ? `${r.alternatives.length + 1} equally-plausible matches for "${query}" — disambiguate with "Class.${r.seed.name}" or "path/to/file:${r.seed.name}" (others: ${r.alternatives.map((s) => s.filePath).join(', ')})`
          : null;
      // stdout stays VALID JSON in --json mode — the notices are structured fields.
      if (!opts.json) {
        if (fuzzyNotice !== null) console.log(pc.yellow(`  ${fuzzyNotice}`));
        if (ambiguityNotice !== null) console.log(pc.dim(`  ${ambiguityNotice}`));
      }
      if (opts.json) {
        // HOR-386 — bolt the SAME router's structured next-steps onto the --json shape
        // (mirrors investigate.ts adding `freshness`). Empty on the happy path.
        const obj = JSON.parse(blastRadiusToJSON(r)) as Record<string, unknown>;
        if (fuzzyNotice !== null) obj.notice = fuzzyNotice;
        if (ambiguityNotice !== null) obj.ambiguityNotice = ambiguityNotice;
        if (r.dbUnavailable) obj.dbUnavailableNote = DB_UNAVAILABLE_NOTE;
        obj.nextSteps = route({ command: 'blast-radius', seedName: r.seed.name, query });
        console.log(JSON.stringify(obj, null, 2));
      } else {
        console.log(renderBlastRadius(r));
        // Single-file build without pglite assets: async queue boundaries couldn't be
        // read. Note it once, dim — the source-graph radius above still stands.
        if (r.dbUnavailable) console.log(pc.dim(`  ${DB_UNAVAILABLE_NOTE}`));
        // D6: a class/interface seed against a pre-inheritance-traversal index may be
        // missing its subclasses/implementors — nudge a reindex (one dim line, never blocks).
        printCapabilityHint(r.seed.id, { json: opts.json });
        if (opts.ai) {
          const result = await renderAiInterpretation({
            command: 'blast-radius',
            userIntent: `query: ${query}`,
            evidence: r,
            promptKind: 'blast-radius',
            outputContract: BLAST_RADIUS_AI_CONTRACT,
            config: opts.config,
            modelOverride: opts.aiModel,
            provider: opts._aiProvider,
          });
          console.log('\n' + renderInterpretation(result));
          if (!result.ok) {
            console.error(pc.yellow(`[ai] ${result.warning}`));
          }
        }
      }
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    return failCommand(err, opts.json);
  }
}
