import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import type { HorusConfig, Symbol, SymbolContext, ImpactResult, Flow } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import { symbolDisplayName, route, formatRouteStep, type RouteStep } from '@horus/engine';
import { openDb, listQueueEdges } from '@horus/db';

/** Print the router's suggestions as human "Suggested next:" lines (HOR-386). */
function printSuggested(steps: RouteStep[]): void {
  for (const s of steps) console.log(pc.dim(`  Suggested next: `) + formatRouteStep(s));
}

export async function runExplain(
  query: string,
  opts: { config?: string; depth?: number; json?: boolean; repo?: string },
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

  const symbols = await code.searchSymbols(query, 5);
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
  if (!isExactMatch) {
    if (await isQueueBoundary(config, query)) {
      console.log(`No exact symbol match for: ${pc.bold(query)}`);
      console.log(
        pc.dim(`  "${query}" matches an async boundary — try: `) + pc.bold(`horus queues ${query}`),
      );
      return 1;
    }
    console.log(
      pc.yellow(`  No exact match for "${query}"`) +
        pc.dim(` — showing closest: "${top.name}" (fuzzy match)`),
    );
  }
  // Semantic search often returns several same-named hits (e.g. a resolver, a service,
  // and a test factory all named `createCompany`). We explain the highest-ranked match
  // and DISCLOSE the collisions so the user can re-query to target another — rather than
  // silently guessing which one they meant (and risking, say, a test factory over the
  // production symbol).
  const siblings = symbols.filter((s) => s.name === top.name && s.id !== top.id);

  const [ctx, impact, flows] = await Promise.all([
    code.context(top.id),
    code.impact(top.id, opts.depth ?? 3),
    code.flowsFor(top.id),
  ]);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          symbol: ctx.symbol,
          community: ctx.community,
          isDead: ctx.isDead,
          callers: ctx.callers,
          callees: ctx.callees,
          impact,
          flows,
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
