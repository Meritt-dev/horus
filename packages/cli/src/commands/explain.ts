import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import type { HorusConfig, Symbol, SymbolContext, ImpactResult, Flow } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import { symbolDisplayName, route, formatRouteStep, rankExactCandidates, type RouteStep } from '@horus/engine';
import { openDb, listQueueEdges } from '@horus/db';

/** Print the router's suggestions as human "Suggested next:" lines (HOR-386). */
function printSuggested(steps: RouteStep[]): void {
  for (const s of steps) console.log(pc.dim(`  Suggested next: `) + formatRouteStep(s));
}

export async function runExplain(
  query: string,
  opts: { config?: string; depth?: number; json?: boolean; full?: boolean; repo?: string },
): Promise<number> {
  const config = await loadConfig(opts.config);
  const code = codeForRepo(config, opts.repo);

  const health = await code.health();
  if (!health.ok) {
    // HOR-386 — host down: the router points at `horus init` (the real remedy).
    const steps = route({ command: 'explain', hostUnreachable: true });
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Source-intelligence host unreachable', nextSteps: steps }, null, 2));
    } else {
      console.error(pc.red('Source-intelligence host unreachable — run: horus init'));
      printSuggested(steps);
    }
    return 1;
  }

  // 10, not 5: exact-name collisions (4 `Hono`s, `Command` vs `command`) must all be
  // in the pool for ranking — a cut-off collision can't be ranked or disclosed.
  const searched = await code.searchSymbols(query, 10);
  // Among candidates matching the query exactly, pick by importance (exact case,
  // declaration kind, real path, body size) — NOT by raw search order, which put a
  // 10-line preset subclass above the real 545-line class (dogfood P1). No exact
  // match → keep the original search-ranked fuzzy fallback.
  const ranked = rankExactCandidates(query, searched);
  const symbols = ranked.length > 0 ? [...ranked, ...searched.filter((s) => !ranked.includes(s))] : searched;
  if (symbols.length === 0) {
    if (await isQueueBoundary(config, query)) {
      console.log(`No symbol found for: ${pc.bold(query)}`);
      console.log(
        pc.dim(`  "${query}" matches an async boundary — try: `) + pc.bold(`horus queues ${query}`),
      );
      return 1;
    }
    // HOR-386 — no symbol matched: the router points at `horus search <query>`.
    const steps = route({ command: 'explain', empty: true, query });
    if (opts.json) {
      console.log(JSON.stringify({ symbol: null, nextSteps: steps }, null, 2));
    } else {
      console.log(`No symbol found for: ${query}`);
      console.log(pc.dim(`  Tip: use an exact class or function name, e.g. "MyService" or "processOrder"`));
      printSuggested(steps);
    }
    return 1;
  }
  const top = symbols[0];
  if (!top) return 1;

  const isExactMatch = top.name.toLowerCase() === query.toLowerCase();
  let fuzzyNotice: string | null = null;
  if (!isExactMatch) {
    if (await isQueueBoundary(config, query)) {
      if (opts.json) {
        console.log(JSON.stringify({ symbol: null, queueBoundary: query }, null, 2));
      } else {
        console.log(`No exact symbol match for: ${pc.bold(query)}`);
        console.log(
          pc.dim(`  "${query}" matches an async boundary — try: `) + pc.bold(`horus queues ${query}`),
        );
      }
      return 1;
    }
    fuzzyNotice = `No exact match for "${query}" — showing closest: "${top.name}" (fuzzy match)`;
    // stdout must be VALID JSON in --json mode (dogfood: human fuzzy text corrupted
    // parsers) — the notice becomes a structured field instead.
    if (!opts.json) {
      console.log(pc.yellow(`  ${fuzzyNotice}`));
    }
  }
  // Semantic search often returns several same-named hits (e.g. a resolver, a service,
  // and a test factory all named `createCompany`). We explain the highest-ranked match
  // and DISCLOSE the collisions so the user can re-query to target another — rather than
  // silently guessing which one they meant (and risking, say, a test factory over the
  // production symbol). Case-insensitive: `Command` (struct) and `command` (method)
  // collide for the query "command" and both must be disclosed.
  const siblings = symbols.filter(
    (s) =>
      s.name.toLowerCase() === top.name.toLowerCase() &&
      s.id !== top.id &&
      // A constructor is named like its class (Java/C#: OwnerController.OwnerController) —
      // listing it as a same-named "other" reads like a duplicate-symbol bug (dogfood N8).
      // Search results don't always carry className (typed /symbols/exact omits it), so
      // ALSO detect the id's `...:Name.Name` constructor shape (gson dogfood, cycle 3).
      !(s.className != null && s.className === s.name) &&
      !s.id.endsWith(`:${s.name}.${s.name}`),
  );

  const [ctx, impact, flows] = await Promise.all([
    code.context(top.id),
    code.impact(top.id, opts.depth ?? 3),
    code.flowsFor(top.id),
  ]);

  if (opts.json) {
    // Compact by default: dogfood showed `explain Client --json` producing enormous
    // output (full neighbour lists, full per-depth impact, snippets with raw source).
    // `--full` restores everything.
    const cap = <T>(xs: T[], n: number) => (opts.full ? xs : xs.slice(0, n));
    const strip = (sym: Record<string, unknown>) => {
      if (opts.full) return sym;
      const { snippet: _s, sourceBody: _b, content: _c, ...rest } = sym;
      return rest;
    };
    const impactOut = opts.full
      ? impact
      : {
          ...impact,
          byDepth: impact.byDepth.map((d) => ({
            ...d,
            symbols: d.symbols.slice(0, 25),
            truncated: d.symbols.length > 25 ? true : undefined,
          })),
        };
    console.log(
      JSON.stringify(
        {
          symbol: strip(ctx.symbol as unknown as Record<string, unknown>),
          ...(fuzzyNotice !== null ? { notice: fuzzyNotice } : {}),
          community: ctx.community,
          isDead: ctx.isDead,
          callers: cap(ctx.callers, 20).map((s) => strip(s as unknown as Record<string, unknown>)),
          callees: cap(ctx.callees, 20).map((s) => strip(s as unknown as Record<string, unknown>)),
          ...(!opts.full && (ctx.callers.length > 20 || ctx.callees.length > 20)
            ? { truncated: 'callers/callees capped at 20 — re-run with --full' }
            : {}),
          impact: impactOut,
          flows: cap(flows, 10),
          // HOR-386 — structured next-steps from the SAME router; empty on the happy path.
          nextSteps: route({ command: 'explain', seedName: top.name, query }),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  renderReport(top, ctx, impact, flows, siblings);
  return 0;
}

async function isQueueBoundary(config: HorusConfig, query: string): Promise<boolean> {
  try {
    // Scope to the active project so a same-named queue in another project doesn't
    // produce a false positive (HOR-207).
    let project: string | undefined;
    try {
      project = resolveEnvironment(config).project;
    } catch {
      /* unresolvable — leave unscoped */
    }
    const { db, sql } = await openDb(config.database.url);
    try {
      const edges = await listQueueEdges(db, { queueName: query, project });
      return edges.length > 0;
    } finally {
      await sql.end().catch(() => {});
    }
  } catch {
    return false;
  }
}

function renderReport(
  top: Symbol,
  ctx: SymbolContext,
  impact: ImpactResult,
  flows: Flow[],
  siblings: Symbol[],
): void {
  const kind = top.id.includes(':') ? top.id.substring(0, top.id.indexOf(':')) : top.id;

  const sym = ctx.symbol;
  let location = sym.filePath;
  if (sym.startLine) {
    location += ':' + sym.startLine;
    if (sym.endLine) {
      location += '-' + sym.endLine;
    }
  }

  const community = ctx.community ? ctx.community.name : pc.dim('—');

  const formatNames = (list: Symbol[]): string => {
    // Qualify class members (e.g. constructor) with their owning class (HOR-214).
    const names = list.map((s) => symbolDisplayName(s));
    if (names.length <= 10) return names.join(', ');
    const extra = names.length - 10;
    return names.slice(0, 10).join(', ') + ` +${extra} more`;
  };

  const callerStr =
    ctx.callers.length === 0 ? pc.dim('none') : formatNames(ctx.callers);
  const calleeStr =
    ctx.callees.length === 0 ? pc.dim('none') : formatNames(ctx.callees);

  const allImpacted: Symbol[] = impact.byDepth.flatMap((d) => d.symbols);
  const impactNames = allImpacted
    .slice(0, 8)
    .map((s) => s.name)
    .join(', ');
  const impactSuffix =
    allImpacted.length > 8 ? ` +${allImpacted.length - 8} more` : '';

  console.log('');
  console.log(
    `  ${pc.bold('Symbol:')}       ${top.name}  ${pc.dim('(kind = ' + kind + ')')}`,
  );
  if (siblings.length > 0) {
    const others = siblings.map((s) => s.filePath).join(', ');
    console.log(
      pc.dim(
        `                ${siblings.length + 1} symbols named '${top.name}'; showing this one — others: ${others}`,
      ),
    );
  }
  console.log(`  ${pc.bold('Location:')}     ${location}`);
  console.log(`  ${pc.bold('Community:')}    ${community}`);
  console.log(
    `  ${pc.bold('Callers (' + ctx.callers.length + '):')}  ${callerStr}`,
  );
  console.log(
    `  ${pc.bold('Callees (' + ctx.callees.length + '):')}  ${calleeStr}`,
  );
  console.log(
    `  ${pc.bold('Impact:')}       ${impact.affected} symbols affected` +
      (impactNames ? `  ${pc.dim(impactNames + impactSuffix)}` : ''),
  );

  console.log(`  ${pc.bold('Related flows:')}`);
  if (flows.length === 0) {
    console.log(`    ${pc.dim('none')}`);
  } else {
    for (const flow of flows) {
      console.log(`    ${flow.name}  ${pc.dim('(' + flow.steps.length + ' steps)')}`);
    }
  }

  if (ctx.isDead) {
    console.log(`  ${pc.bold('Dead code:')}    ${pc.red('yes')}`);
  }

  console.log('');
}
