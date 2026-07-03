/**
 * `horus metrics` — Grafana metrics evidence provider (HOR-11 reframe).
 * Discovers dashboards/panels, fetches metric series via datasource proxy,
 * and surfaces latency spikes, error-rate changes, throughput drops, queue growth.
 */

import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { metricsProviderFromConfig, extractHintTokens } from '@horus/connectors';
import { summarize } from '@horus/connectors';
import type { MetricFinding } from '@horus/connectors';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const METRICS_AI_CONTRACT = `Provide a clearly separated AI evidence narration with:

Evidence used
- Exact panel names, anomaly types, baseline vs. current values, and ratios Horus found

What stands out
- The most severe or highest-ratio anomalies
- Any metric dimensions with correlated movement (e.g. error rate + latency both spiking)

What this may indicate
- Use "may suggest", "is consistent with", or "could indicate" — never "proves"
- Do not invent dashboard panels or panel names not in the evidence

What is not proven
- Claims that cannot be made from metric anomalies alone (root cause, data loss, user scope)

Next checks
- Exact Horus commands or Grafana dashboards to inspect next`;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parse a duration string (e.g. "1h", "30m", "2d", "90s") into seconds.
 * Defaults to 3600 (1h) for unrecognised strings.
 */
function sinceSecs(s: string | undefined): number {
  if (s === undefined) return 3600;
  const match = /^(\d+)(s|m|h|d)$/.exec(s);
  if (match === null) return 3600;
  const amount = parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 's';
  const table: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return (table[unit] ?? 1) * amount;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function labelStr(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}="${v}"`).join(', ');
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(4);
}

function anomalyColor(anomaly: MetricFinding['anomaly']): (s: string) => string {
  switch (anomaly) {
    case 'latency-spike':
    case 'error-rate-change':
    case 'throughput-drop':
      return pc.red;
    case 'queue-growth':
    case 'change':
      return pc.yellow;
    default:
      return (s: string) => s;
  }
}

function anomalyLabel(anomaly: MetricFinding['anomaly']): string {
  switch (anomaly) {
    case 'latency-spike':
      return 'LATENCY-SPIKE';
    case 'error-rate-change':
      return 'ERROR-RATE-CHANGE';
    case 'throughput-drop':
      return 'THROUGHPUT-DROP';
    case 'queue-growth':
      return 'QUEUE-GROWTH';
    case 'change':
      return 'CHANGE';
    case 'bimodal-population':
      return 'BIMODAL-POPULATION';
    case 'none':
      return 'OK';
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runMetrics(
  hint: string | undefined,
  opts: {
    config?: string;
    since?: string;
    step?: string;
    dashboard?: string;
    query?: string;
    json?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const metrics = metricsProviderFromConfig(config);

    if (metrics === null) {
      console.error(
        pc.red(
          'Grafana not configured — set GRAFANA_URL + GRAFANA_USER + GRAFANA_PASSWORD',
        ),
      );
      return 1;
    }

    const health = await metrics.health();
    if (!health.ok) {
      console.error(pc.red(`Grafana unreachable: ${health.detail}`));
      return 1;
    }

    const stepNum = opts.step !== undefined ? Number(opts.step) : undefined;
    const dur = sinceSecs(opts.since);
    const to = nowSecs();
    const from = to - dur;

    // --query: raw escape hatch — execute a single PromQL expression
    if (opts.query !== undefined && opts.query !== '') {
      const series = await metrics.rawRange(opts.query, from, to, stepNum);
      if (opts.json === true) {
        // Respect --json on the query path too (HOR-210) — empty results return a
        // structured empty response, not plain text.
        console.log(
          JSON.stringify(
            {
              query: opts.query,
              from,
              to,
              step: stepNum,
              series: series.map((s) => {
                const summary = summarize(s);
                return { labels: s.labels, last: summary.last, avg: summary.avg };
              }),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      if (series.length === 0) {
        console.log(pc.dim('No series returned.'));
        return 0;
      }
      for (const s of series) {
        const summary = summarize(s);
        const label = labelStr(s.labels);
        console.log(
          `  ${pc.cyan(label || '(no labels)')}` +
            `  last=${pc.bold(fmtNum(summary.last))}` +
            `  avg=${fmtNum(summary.avg)}`,
        );
      }
      return 0;
    }

    // Default: Grafana panel discovery + anomaly detection
    const findings = await metrics.analyze({ hint, from, to, step: stepNum });

    if (opts.json === true) {
      console.log(JSON.stringify(findings, null, 2));
      return 0;
    }

    const flagged = findings.filter((f) => f.anomaly !== 'none');
    const ok = findings.filter((f) => f.anomaly === 'none');

    if (findings.length === 0) {
      if (hint !== undefined) {
        const tokens = extractHintTokens(hint);
        console.log(pc.dim(`No panels matched hint "${hint}".`));
        if (tokens.length > 0) {
          console.log(pc.dim(`  Searched for panels containing: ${tokens.join(', ')}`));
        }
        console.log(
          pc.dim(
            `  Tip: run ${pc.bold('horus metrics')} (no hint) to see all available panels,` +
              ` then use a panel title or keyword directly.`,
          ),
        );
      } else {
        console.log(pc.dim('No panels found in configured Grafana dashboards.'));
      }
      return 0;
    }

    const hintSuffix = hint !== undefined ? ` (hint: "${hint}")` : '';
    // Show how the hint matched so users understand which field drove the result.
    const matchSources = hint !== undefined
      ? [...new Set(findings.map((f) => f.matchSource).filter(Boolean))]
      : [];
    const matchSuffix =
      matchSources.length > 0
        ? pc.dim(` [matched via ${matchSources.join(', ')}]`)
        : '';
    console.log(
      pc.bold(
        `Grafana metrics${hintSuffix} — ${findings.length} series across panels`,
      ) + matchSuffix,
    );
    console.log(
      pc.dim(
        `  window: ${new Date(from * 1000).toISOString()} – ${new Date(to * 1000).toISOString()}`,
      ),
    );
    console.log('');

    if (flagged.length === 0) {
      console.log(pc.green('  No anomalies detected.'));
    } else {
      for (const f of flagged) {
        const color = anomalyColor(f.anomaly);
        const label = anomalyLabel(f.anomaly);
        const ratioStr = Number.isFinite(f.ratio) ? `x${f.ratio.toFixed(2)}` : 'xinf';
        const lblStr = labelStr(f.labels);
        console.log(
          color(
            `  ${label.padEnd(22)}  ${f.panelTitle.padEnd(40).slice(0, 40)}` +
              `  ${fmtNum(f.baselineAvg)} -> ${fmtNum(f.currentAvg)} (${ratioStr})` +
              (lblStr !== '' ? `  ${pc.dim(lblStr)}` : ''),
          ),
        );
      }
    }

    if (ok.length > 0) {
      console.log('');
      console.log(pc.dim(`  ${ok.length} panel series with no anomaly.`));
    }

    if (opts.ai) {
      const result = await renderAiInterpretation({
        command: 'metrics',
        userIntent: hint ? `hint: ${hint}` : undefined,
        evidence: findings,
        promptKind: 'evidence-summary',
        outputContract: METRICS_AI_CONTRACT,
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
