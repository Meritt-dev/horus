import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { SourceHttpClient, type SourceInsightsResult } from '@horus/connectors';
import { ensureOwnSourceHost, ensureHostReasonHint } from '../lib/ensure-host.js';
import { failCommand } from '../lib/command-failure.js';

/** Render the graph-insights report as human-readable text. */
export function renderInsights(r: SourceInsightsResult): string {
  const out: string[] = [];

  out.push(pc.bold('Hubs') + pc.dim(' — most-connected symbols'));
  if (r.hubs.length === 0) {
    out.push(pc.dim('  none (empty or unindexed graph)'));
  } else {
    for (const h of r.hubs) {
      const label = h.label.charAt(0).toUpperCase() + h.label.slice(1);
      out.push(
        `  ${String(h.degree).padStart(3)}  ${h.name} ${pc.dim(`(${label}) — ${h.filePath}:${h.startLine}`)}`,
      );
    }
  }

  out.push('');
  out.push(pc.bold('Surprising connections') + pc.dim(' — edges bridging communities'));
  if (r.bridges.length === 0) {
    out.push(pc.dim('  none detected (run community detection first)'));
  } else {
    for (const b of r.bridges) {
      out.push(
        `  ${b.source} --${b.relType}--> ${b.target}  ${pc.dim(`[${b.sourceCommunity} → ${b.targetCommunity}]`)}`,
      );
    }
  }

  if (r.questions.length > 0) {
    out.push('');
    out.push(pc.bold('Suggested questions'));
    for (const q of r.questions) out.push(`  ${pc.dim('•')} ${q}`);
  }

  return out.join('\n');
}

export async function runInsights(opts: {
  config?: string;
  json?: boolean;
  hubs?: number;
  bridges?: number;
}): Promise<number> {
  try {
    await loadConfig(opts.config);
    const host = await ensureOwnSourceHost(process.cwd());
    if (!host.ok || !host.hostUrl) {
      const hint = ensureHostReasonHint(host.reason);
      if (opts.json) {
        console.log(JSON.stringify({ error: 'Source-intelligence host unavailable', hint }, null, 2));
      } else {
        console.error(pc.red('Source-intelligence host unavailable'));
        console.error(pc.dim(`  ${hint}`));
      }
      return 1;
    }

    const client = new SourceHttpClient({ baseUrl: host.hostUrl });
    const result = await client.insights({
      ...(opts.hubs != null ? { hubLimit: opts.hubs } : {}),
      ...(opts.bridges != null ? { bridgeLimit: opts.bridges } : {}),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderInsights(result));
    }
    return 0;
  } catch (err) {
    return failCommand(err, opts.json);
  }
}
