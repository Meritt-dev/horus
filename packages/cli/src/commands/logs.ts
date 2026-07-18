/**
 * `horus logs` — turn logs into EVIDENCE (HOR-10). The default view synthesizes
 * error signatures (count, first/last occurrence, affected services, NEW/spike);
 * `--raw` falls back to a plain line dump for humans who want the raw lines.
 *
 * Project/environment-scoped (HOR-34): resolves the Elasticsearch connector for
 * the chosen project/env — there is no global Elasticsearch default.
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { logsForEnv, shortTs, extractContextFields } from '@horus/connectors';
import type { LogLevel } from '@horus/connectors';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const LOGS_AI_CONTRACT = `Provide a clearly separated AI evidence narration with:

Evidence used
- Exact error signatures, counts, first/last timestamps, and affected services Horus found

What stands out
- The most frequent or newest signatures
- Services appearing disproportionately across signatures

What this may indicate
- Use "may suggest", "is consistent with", or "could indicate" — not "proves" or "caused by"
- Correlation hints only (e.g. "the spike overlaps with the deployment window")

What is not proven
- Claims that cannot be made from error logs alone (root cause, user impact, fix)

Next checks
- Exact Horus commands, dashboards, or files to inspect next`;

/** Parse "24h" / "7d" / "30m" into an ISO "now minus that"; pass ISO through. */
function sinceToIso(since: string | undefined): string | undefined {
  if (since === undefined) return undefined;
  const match = /^(\d+)(m|h|d)$/.exec(since);
  if (match === null) return since;
  const amount = parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 'm';
  const msMap: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() - (msMap[unit] ?? 60_000) * amount).toISOString();
}

/**
 * Resolve the severity floor for `--raw` (HOR-209). Defaults to `error` so raw lines
 * match the summary's error+ view; an explicit `--level` overrides; `--all-levels`
 * removes the floor entirely (returns undefined = all levels).
 */
export function resolveRawLevel(opts: { level?: string; allLevels?: boolean }): LogLevel | undefined {
  if (opts.allLevels) return undefined;
  return (opts.level as LogLevel | undefined) ?? 'error';
}

/**
 * Parse repeatable `--where field=value` into structured filters (HOR-344).
 * Throws on a malformed entry so the user gets a clear message instead of a
 * silently-ignored filter.
 */
export function parseWhere(raw: string[] | undefined): { field: string; value: string }[] {
  if (raw === undefined) return [];
  return raw.map((entry) => {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(
        `Invalid --where "${entry}" — expected field=value, e.g. --where context.brand_id=42`,
      );
    }
    return { field: entry.slice(0, eq).trim(), value: entry.slice(eq + 1).trim() };
  });
}

const whereLabel = (where: { field: string; value: string }[]): string =>
  where.map((w) => `${w.field}=${w.value}`).join(', ');

function levelColor(level: string, text: string): string {
  if (level === 'error' || level === 'fatal') return pc.red(text);
  if (level === 'warn') return pc.yellow(text);
  return pc.dim(text);
}

export interface ServiceMatch {
  kind: 'unique' | 'ambiguous' | 'none';
  /** The resolved label when kind === 'unique'. */
  matched?: string;
  /** The competing labels when kind === 'ambiguous'. */
  candidates?: string[];
}

/**
 * Resolve a requested service name against the labels that actually appear in the logs.
 * Exact match wins; otherwise a case-insensitive substring match. HOR-319 (Bug 3):
 * `horus logs scheduler` should resolve to `acme-prod-scheduler` rather than silently
 * widening to all services on an exact-match miss.
 */
export function matchServiceLabel(requested: string, candidates: string[]): ServiceMatch {
  if (candidates.includes(requested)) return { kind: 'unique', matched: requested };
  const needle = requested.toLowerCase();
  const subs = candidates.filter((c) => c.toLowerCase().includes(needle));
  if (subs.length === 1 && subs[0] !== undefined) return { kind: 'unique', matched: subs[0] };
  if (subs.length > 1) return { kind: 'ambiguous', candidates: subs };
  return { kind: 'none' };
}

export async function runLogs(
  service: string | undefined,
  opts: {
    config?: string;
    env?: string;
    since?: string;
    level?: string;
    grep?: string;
    raw?: boolean;
    /** Show all severity levels in --raw (default is error+ to match the summary). */
    allLevels?: boolean;
    /** Aggregate error counts by a context/structured field (e.g. context.brand_id). */
    groupBy?: string;
    /** Repeatable structured filters: context.field=value, AND-combined (HOR-344). */
    where?: string[];
    errors?: boolean;
    limit?: string;
    json?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  try {
    let where: { field: string; value: string }[];
    try {
      where = parseWhere(opts.where);
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }
    const hasWhere = where.length > 0;
    const whereArg = hasWhere ? where : undefined;

    const config = await loadConfig(opts.config);

    let renv;
    try {
      renv = resolveEnvironment(config, { env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const logs = logsForEnv(renv);
    if (logs === null) {
      console.error(
        pc.red(
          `No Elasticsearch connector configured for ${renv.project}/${renv.env} ` +
            `(set ES_URL / ES_USERNAME / ES_PASSWORD)`,
        ),
      );
      return 1;
    }

    const health = await logs.health();
    if (!health.ok) {
      console.error(pc.red(`Elasticsearch unreachable: ${health.detail}`));
      return 1;
    }

    const resolvedService = service ?? renv.connectors.elasticsearch?.serviceName;
    const indexPattern = renv.connectors.elasticsearch?.indexPattern ?? '*';

    // Validate that the configured field mapping is compatible with the actual
    // index before querying. Errors block collection; warnings are advisory.
    // Pass requiresService so a missing service field blocks rather than silently
    // returning zero results.
    try {
      // Only the default analysis path aggregates by the event-code + service
      // fields. raw mode dumps lines (searchLogs); --group-by aggregates a custom
      // field — neither requires the configured event-code field to be present.
      const aggregatesEventCode = opts.raw !== true && opts.groupBy === undefined;
      const compat = await logs.checkCompatibility({
        requiresService: resolvedService !== undefined,
        requiresServiceAggregation: aggregatesEventCode,
        requiresEventCode: aggregatesEventCode,
      });
      for (const w of compat.issues.filter((i) => i.severity === 'warning')) {
        console.warn(pc.yellow(`[warn] ${w.field}: ${w.message}`));
      }
      const errors = compat.issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        console.error(pc.red('Elasticsearch field mapping is incompatible with the index:'));
        for (const e of errors) {
          console.error(pc.red(`  ${e.field}: ${e.message}`));
        }
        console.error(
          pc.dim('Fix fields.* overrides in your connector config or choose the correct preset.'),
        );
        return 1;
      }
    } catch {
      // Compat check is best-effort: network or auth errors must not prevent
      // legitimate queries from proceeding.
      console.warn(pc.dim('[warn] Elasticsearch compatibility check unavailable — proceeding.'));
    }

    // Default to 7 days to match the investigation engine's default window
    // (investigation uses logWindowFrom(undefined) = 7d; former implicit default was 24h).
    const from = sinceToIso(opts.since) ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const fromDisplay = from.slice(0, 16).replace('T', ' ');

    // --raw: the escape hatch for an actual line dump. By default it preserves the
    // summary's error+ severity filter so `--raw` surfaces the same errors the summary
    // counts (HOR-209) — previously it dumped recent INFO/DEBUG. An explicit --level
    // overrides; --all-levels removes the severity floor entirely.
    if (opts.raw === true) {
      // A --where lookup targets specific structured records, often emitted at
      // INFO/DEBUG — so don't apply the error+ floor unless --level is explicit
      // (HOR-344: the error+ default previously hid the INFO activation logs).
      const rawLevel = hasWhere && opts.level === undefined ? undefined : resolveRawLevel(opts);
      // A filtered lookup wants the matching records, not a 20-line preview.
      const defaultLimit = hasWhere ? 200 : 20;
      const limit = opts.limit !== undefined ? Math.min(Number(opts.limit), 1000) : defaultLimit;
      const records = await logs.searchLogs({
        service: resolvedService,
        from,
        level: rawLevel,
        text: opts.grep,
        // grep searches message + detail + context.* so error strings buried
        // outside the message field are still found (HOR-216).
        broadText: opts.grep !== undefined,
        where: whereArg,
        limit,
      });
      const truncated = records.length === limit;
      if (opts.json) {
        // Curated record shape — omit the raw ES doc (may be large / contain anything).
        console.log(
          JSON.stringify(
            {
              scope: {
                project: renv.project,
                env: renv.env,
                service: resolvedService ?? null,
                index: indexPattern,
                from,
                level: rawLevel ?? 'all',
                grep: opts.grep ?? null,
                where: whereArg ?? null,
                truncated,
              },
              records: records.map((r) => ({
                timestamp: r.timestamp,
                level: r.level,
                service: r.service ?? null,
                component: r.component ?? null,
                eventCode: r.eventCode ?? null,
                message: r.message,
                // Structured fields restored to raw output (HOR-215/216).
                context: r.context ?? null,
                detail: r.detail ?? null,
                traceId: r.traceId ?? null,
                requestId: r.requestId ?? null,
              })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      // Surface the scope on stderr (so it never pollutes piped stdout) — this is
      // where the error+ default and any --where filters become visible (HOR-344).
      console.error(
        pc.dim(
          `logs: ${renv.project}/${renv.env}` +
            (resolvedService ? ` · service ${resolvedService}` : '') +
            ` · from ${fromDisplay} UTC · level ${rawLevel ?? 'all'}` +
            (hasWhere ? ` · where ${whereLabel(where)}` : '') +
            (opts.grep ? ` · grep "${opts.grep}"` : '') +
            (rawLevel === 'error' && !hasWhere
              ? '  (error+ only — use --all-levels for info/debug)'
              : ''),
        ),
      );
      if (records.length === 0) {
        console.log(pc.dim('No logs matched.'));
        return 0;
      }
      for (const r of records) {
        const ts = r.timestamp ? r.timestamp.slice(0, 23) : '                       ';
        const lvl = `[${r.level.toUpperCase().padEnd(5)}]`;
        const comp = (r.component ?? r.service ?? '').padEnd(30).slice(0, 30);
        const line = `${ts}  ${lvl}  ${comp}  ${r.message.slice(0, 120)}`;
        console.log(levelColor(r.level, line));
        // Restore structured context beneath the message line so the raw view is
        // actually debuggable (event_code, entity ids, buried error) (HOR-215).
        for (const { key, value } of extractContextFields(r)) {
          console.log(pc.dim(`    ${key}: ${value.slice(0, 200)}`));
        }
      }
      if (truncated) {
        console.error(
          pc.yellow(
            `[warn] showing the first ${limit} record(s) — results may be truncated. ` +
              `Narrow with --where/--since/--level or raise --limit (max 1000).`,
          ),
        );
      }
      return 0;
    }

    // --group-by: aggregate error counts by a structured/context field and show the
    // top entities — the manual "aggregate by context.brand_id in ES" detour, built
    // in (HOR-215). error+ severity, scoped by service/window/grep.
    if (opts.groupBy !== undefined) {
      const field = opts.groupBy;
      const buckets = await logs.aggregateErrors(
        {
          service: resolvedService,
          from,
          text: opts.grep,
          broadText: opts.grep !== undefined,
          where: whereArg,
        },
        field,
      );
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              scope: {
                project: renv.project,
                env: renv.env,
                service: resolvedService ?? null,
                index: indexPattern,
                from,
                severity: 'error+',
                grep: opts.grep ?? null,
                where: whereArg ?? null,
                groupBy: field,
              },
              buckets,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      console.log(
        pc.bold(`Top ${field}`) +
          pc.dim(
            ` — ${renv.project}/${renv.env}` +
              (resolvedService ? ` · service ${resolvedService}` : '') +
              (opts.grep ? ` · grep "${opts.grep}"` : '') +
              (hasWhere ? ` · where ${whereLabel(where)}` : ''),
          ),
      );
      console.log(pc.dim(`  index: ${indexPattern} · from: ${fromDisplay} UTC · severity: error+`));
      console.log('');
      if (buckets.length === 0) {
        console.log(pc.dim(`  No error logs with field "${field}" in the window.`));
        console.log(pc.dim(`  Tip: ensure "${field}" is an aggregatable (keyword) field.`));
        return 0;
      }
      for (const b of buckets) {
        console.log(`  ${pc.red(String(b.count).padStart(6))}  ${b.key}`);
      }
      console.log('');
      console.log(pc.dim(`  ${buckets.length} distinct ${field} value(s) shown (top by error count).`));
      return 0;
    }

    // Default: synthesize error evidence.
    let analysis = await logs.analyzeErrors({
      service: resolvedService,
      from,
      text: opts.grep,
      broadText: opts.grep !== undefined,
      where: whereArg,
    });

    let scopeService = resolvedService;
    let broadeningNote: string | undefined;

    // Broader discovery mode: when a service filter returns 0 signatures, retry
    // without the filter so the user sees the actual log volume in this environment.
    // This prevents `horus logs "sale"` from silently implying there are no errors
    // when investigation can find thousands (HOR-157).
    if (analysis.signatures.length === 0 && resolvedService !== undefined) {
      const broader = await logs.analyzeErrors({ from, text: opts.grep, broadText: opts.grep !== undefined, where: whereArg });
      if (broader.signatures.length > 0) {
        // HOR-319 (Bug 3): before silently widening to all services, try to resolve the
        // requested name against the labels that actually carry errors. An exact label
        // mismatch (e.g. `scheduler` vs `acme-prod-scheduler`) shouldn't drop the scope.
        // Note: candidates come from the affected-services aggregation, so a service with
        // zero errors in the window can't be matched — that's fine for error analysis.
        const match = matchServiceLabel(resolvedService, broader.affectedServices);
        if (match.kind === 'unique' && match.matched !== undefined && match.matched !== resolvedService) {
          const scoped = await logs.analyzeErrors({
            service: match.matched,
            from,
            text: opts.grep,
            broadText: opts.grep !== undefined,
            where: whereArg,
          });
          if (scoped.signatures.length > 0) {
            analysis = scoped;
            scopeService = match.matched;
            broadeningNote = `No exact match for service "${resolvedService}" — matched "${match.matched}"`;
          } else {
            analysis = broader;
            scopeService = undefined;
            broadeningNote = `No errors found for service "${resolvedService}" — showing all services`;
          }
        } else if (match.kind === 'ambiguous' && match.candidates !== undefined) {
          analysis = broader;
          scopeService = undefined;
          broadeningNote = `"${resolvedService}" matches multiple services: ${match.candidates.join(', ')} — showing all; re-run with a full label`;
        } else {
          analysis = broader;
          scopeService = undefined;
          broadeningNote = `No errors found for service "${resolvedService}" — showing all services`;
        }
      }
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            scope: {
              project: renv.project,
              env: renv.env,
              service: scopeService ?? null,
              index: indexPattern,
              from,
              severity: 'error+',
              grep: opts.grep ?? null,
              where: whereArg ?? null,
            },
            totalErrors: analysis.totalErrors,
            signatures: analysis.signatures,
            newSignatures: analysis.newSignatures,
            affectedServices: analysis.affectedServices,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    console.log(
      pc.bold(`Error analysis`) +
        pc.dim(
          ` — ${renv.project}/${renv.env}` +
            (scopeService ? ` · service ${scopeService}` : '') +
            (opts.grep ? ` · grep "${opts.grep}"` : '') +
            (hasWhere ? ` · where ${whereLabel(where)}` : ''),
        ),
    );
    console.log(pc.dim(`  index: ${indexPattern} · from: ${fromDisplay} UTC · severity: error+`));
    if (broadeningNote) {
      console.log(pc.yellow(`  ${broadeningNote}`));
    }
    console.log(
      `  ${analysis.totalErrors} error(s) · ${analysis.signatures.length} signature(s) · ${pc.yellow(String(analysis.newSignatures.length))} new`,
    );
    console.log('');

    if (analysis.signatures.length === 0) {
      // Don't claim "no error-level logs" when the count says otherwise — that
      // contradictory render is exactly the tripwire the count/signature split
      // produced. Be honest about which case this is.
      console.log(
        pc.dim(
          analysis.totalErrors > 0
            ? `  ${analysis.totalErrors} error-level log(s) matched, but none could be grouped into a signature (missing the code field). Try --raw to see the lines.`
            : '  No error-level logs in the window.',
        ),
      );
      console.log(
        pc.dim(
          `  Searched: ${scopeService ? `service "${scopeService}"` : 'all services'} · index: ${indexPattern} · from: ${fromDisplay} UTC`,
        ),
      );
      console.log(pc.dim(`  Tip: use --since to widen the window (e.g. --since 30d).`));
      return 0;
    }

    for (const s of analysis.signatures) {
      const tags: string[] = [];
      if (s.isNew) tags.push(pc.red('NEW'));
      else if (s.ratio !== undefined && Number.isFinite(s.ratio) && s.ratio >= 1.5) {
        tags.push(pc.yellow(`spike x${s.ratio.toFixed(1)}`));
      }
      const svc = s.services.length > 0 ? pc.dim(` · ${s.services.slice(0, 3).join(', ')}`) : '';
      const tagStr = tags.length > 0 ? `  [${tags.join(', ')}]` : '';
      console.log(
        `  ${pc.red(String(s.count).padStart(6))}  ${pc.bold(s.key.padEnd(14).slice(0, 14))}  ` +
          pc.dim(`first ${shortTs(s.firstSeen)} · last ${shortTs(s.lastSeen)}`) +
          svc +
          tagStr,
      );
    }

    if (analysis.affectedServices.length > 0) {
      console.log('');
      console.log(`  ${pc.bold('Affected services:')} ${analysis.affectedServices.join(', ')}`);
    }
    console.log('');
    console.log(pc.dim('  (use --raw to see individual log lines)'));

    if (opts.ai) {
      const result = await renderAiInterpretation({
        command: 'logs',
        userIntent: scopeService ? `service: ${scopeService}` : undefined,
        evidence: {
          totalErrors: analysis.totalErrors,
          signatures: analysis.signatures,
          newSignatures: analysis.newSignatures,
          affectedServices: analysis.affectedServices,
        },
        promptKind: 'evidence-summary',
        outputContract: LOGS_AI_CONTRACT,
        config: opts.config,
        modelOverride: opts.aiModel,
        provider: opts._aiProvider,
      });
      console.log('\n' + renderInterpretation(result));
      if (!result.ok) {
        console.error(pc.yellow(`[ai] ${result.warning}`));
      }
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
