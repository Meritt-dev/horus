import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { SourceHttpClient, type SourceTraceResult } from '@horus/connectors';
import { ensureOwnSourceHost, ensureHostReasonHint } from '../lib/ensure-host.js';
import { failCommand } from '../lib/command-failure.js';

/** Visual confidence indicator mirroring the source host's MCP renderer. */
function confidenceTag(confidence: number): string {
  if (confidence >= 0.9) return '';
  if (confidence >= 0.5) return ' (~)';
  return ' (?)';
}

/** Build the `A --calls--> B <--imports-- C` arrow chain from the structured result. */
export function renderTrace(result: SourceTraceResult): string {
  if (!result.found) {
    const lines = [result.error ?? 'No path found.'];
    for (const n of result.notes ?? []) lines.push(pc.dim(`  ${n}`));
    return lines.join('\n');
  }
  const path = result.path ?? [];
  const segments = result.segments ?? [];
  const chain = [path[0]?.name ?? '?'];
  segments.forEach((seg, i) => {
    const tag = confidenceTag(seg.confidence);
    const next = path[i + 1]?.name ?? '?';
    chain.push(
      seg.direction === 'out'
        ? `--${seg.relType}${tag}--> ${next}`
        : `<--${seg.relType}${tag}-- ${next}`,
    );
  });
  const hops = result.hops ?? segments.length;
  const out = [`Trace: ${chain.join(' ')} (${hops} hop${hops === 1 ? '' : 's'})`, ''];
  path.forEach((n, i) => {
    const label = n.label.charAt(0).toUpperCase() + n.label.slice(1);
    out.push(`  ${i + 1}. ${n.name} (${label}) — ${n.filePath}:${n.startLine}`);
  });
  for (const n of result.notes ?? []) out.push('', pc.dim(n));
  return out.join('\n');
}

export async function runTrace(
  from: string,
  to: string,
  opts: {
    config?: string;
    json?: boolean;
    maxDepth?: number;
    relations?: string;
  },
): Promise<number> {
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
    const relations = opts.relations
      ? opts.relations.split(',').map((r) => r.trim()).filter(Boolean)
      : undefined;
    const result = await client.trace(from, to, {
      ...(opts.maxDepth != null ? { maxDepth: opts.maxDepth } : {}),
      ...(relations ? { relations } : {}),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderTrace(result));
    }
    // A resolution failure or unreachable target is a non-zero exit so scripts can react.
    return result.found ? 0 : 1;
  } catch (err) {
    return failCommand(err, opts.json);
  }
}
