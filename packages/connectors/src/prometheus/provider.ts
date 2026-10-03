import { runtimeSchemas, redactErrorMessage, type RuntimeConfig } from '@horus/core';
import type { MetricsProvider } from '../grafana/provider.js';
import { parseRange } from '../grafana/series.js';
import { classifyPanel, panelMatchesHint, findMatchSource, findingLabelsMatchHint, type Panel } from '../grafana/panels.js';
import {
  buildFindings,
  findingsToEvidence,
  type MetricFinding,
} from '../grafana/analyze.js';
import { fetchWithRetry } from '../http.js';

/** Direct Prometheus uses the same normalization and anomaly analysis as Grafana. */
export class PrometheusMetricsProvider implements MetricsProvider {
  readonly id = 'prometheus';
  readonly kind = 'metrics' as const;
  readonly config: RuntimeConfig['prometheus'];
  constructor(config: RuntimeConfig['prometheus']) {
    this.config = runtimeSchemas.prometheus.parse(config);
  }
  async findPanels(hint?: string): Promise<Panel[]> {
    return this.config.queries
      .map((q, i) => ({
        id: i,
        title: q.title,
        exprs: [q.expr],
        kind: classifyPanel(q.title, '', [q.expr]),
        type: 'timeseries',
        unit: '',
        datasourceUid: 'prometheus',
        dashboardUid: 'prometheus',
      }))
      .filter((p) => !hint || panelMatchesHint(p, hint));
  }
  private async query(
    expr: string,
    from: number,
    to: number,
    step = 60,
    signal?: AbortSignal,
  ) {
    if (![from, to, step].every(Number.isFinite) || from > to || step <= 0)
      throw new Error('Invalid metric time window');
    const url = new URL(`${this.config.url.replace(/\/$/, '')}/api/v1/query_range`);
    url.search = new URLSearchParams({
      query: expr,
      start: String(from),
      end: String(to),
      step: String(Math.max(step, Math.ceil((to - from) / 1000))),
      timeout: '15s',
      limit: '200',
    }).toString();
    const response = await fetchWithRetry(
      url.toString(),
      {
        headers: this.config.token
          ? { Authorization: `Bearer ${this.config.token}` }
          : {},
      },
      { timeoutMs: 20000, signal },
    );
    if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}`);
    const data = (await response.json()) as { status?: string };
    if (data.status !== 'success') throw new Error('Prometheus query failed');
    return parseRange(data);
  }
  rawRange(expr: string, from: number, to: number, step?: number) {
    return this.query(expr, from, to, step);
  }
  async analyze(opts: {
    hint?: string;
    from: number;
    to: number;
    step?: number;
    signal?: AbortSignal;
  }): Promise<MetricFinding[]> {
    const findings: MetricFinding[] = [];
    const panels = await this.findPanels(opts.hint);
    const labelFallback = panels.length === 0 && !!opts.hint;
    for (const p of labelFallback ? await this.findPanels() : panels) {
      const [current, baseline] = await Promise.all([
        this.query(p.exprs[0]!, opts.from, opts.to, opts.step, opts.signal),
        this.query(
          p.exprs[0]!,
          opts.from - (opts.to - opts.from),
          opts.from,
          opts.step,
          opts.signal,
        ),
      ]);
      const matched = buildFindings('prometheus', p.title, p.kind, baseline, current);
      findings.push(...(labelFallback
        ? matched.filter(f => findingLabelsMatchHint(f.labels, opts.hint!))
          .map(f => ({ ...f, matchSource: 'series-labels' as const }))
        : matched.map(f => ({ ...f, matchSource: opts.hint ? findMatchSource(p, opts.hint) : null }))));
    }
    return findings;
  }
  toEvidence(findings: MetricFinding[]) {
    return findingsToEvidence(
      findings.filter((f) => f.anomaly !== 'none'),
      'prometheus.analyze',
      new Date().toISOString(),
    );
  }
  async health() {
    try {
      await this.query('up', Date.now() / 1000 - 60, Date.now() / 1000);
      return { ok: true, detail: 'Prometheus query access verified' };
    } catch (e) {
      return { ok: false, detail: redactErrorMessage(e) };
    }
  }
}
