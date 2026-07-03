/**
 * Grafana HTTP API client for @horus/connectors (HOR-11 reframe).
 * All Prometheus queries are routed through the Grafana datasource proxy —
 * no direct Prometheus access required.
 */

import type { HealthStatus } from '@horus/core';
import { redactErrorMessage, redactSecrets, redactUpstreamBody } from '@horus/core';
import { fetchWithRetry, type HttpRequestOptions } from '../http.js';

export interface GrafanaClientOpts {
  baseUrl: string;
  username?: string;
  password?: string;
  /** Transport overrides (timeout / retry) forwarded to fetchWithRetry. */
  http?: HttpRequestOptions;
}

export class GrafanaClient {
  private readonly baseUrl: string;
  private readonly authHeader: string | undefined;
  private readonly http: HttpRequestOptions;

  constructor(opts: GrafanaClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    if (opts.username !== undefined && opts.password !== undefined) {
      const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
      this.authHeader = `Basic ${encoded}`;
    }
    this.http = opts.http ?? {};
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader !== undefined) {
      headers['Authorization'] = this.authHeader;
    }
    return headers;
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    // A caller-supplied signal (e.g. the engine's metrics budget) composes with
    // the helper's per-attempt timeout; aborts are never retried, so budget
    // aborts still yield prompt partial-metrics results (HOR-339).
    const res = await fetchWithRetry(
      url,
      { method: 'GET', headers: this.buildHeaders() },
      { ...this.http, ...(signal !== undefined ? { signal } : {}) },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Redact the WHOLE message: ${url} is the full request URL, so a baseUrl
      // configured with userinfo (https://user:pass@grafana) would leak here
      // even with an empty body. The body is redacted BEFORE capping so a
      // secret straddling the 200-char boundary can never survive truncated.
      throw new Error(
        redactSecrets(`Grafana GET ${url} -> ${res.status}: ${redactUpstreamBody(text)}`),
      );
    }
    const json = await res.json().catch(() => {
      throw new Error(`Grafana GET ${url}: response is not valid JSON`);
    });
    return json;
  }

  /** GET /api/health — returns ok:true on 200. */
  async health(): Promise<HealthStatus> {
    try {
      await this.getJson(`${this.baseUrl}/api/health`);
      return { ok: true, detail: 'grafana ok' };
    } catch (err) {
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }

  /** GET /api/search?type=dash-db[&query=<q>] */
  async searchDashboards(
    query?: string,
    signal?: AbortSignal,
  ): Promise<{ uid: string; title: string; folderTitle?: string }[]> {
    const qs = new URLSearchParams({ type: 'dash-db' });
    if (query !== undefined && query !== '') {
      qs.set('query', query);
    }
    const url = `${this.baseUrl}/api/search?${qs.toString()}`;
    const raw = await this.getJson(url, signal);
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).map((item) => {
      const it = item as Record<string, unknown>;
      return {
        uid: String(it['uid'] ?? ''),
        title: String(it['title'] ?? ''),
        folderTitle:
          it['folderTitle'] !== undefined ? String(it['folderTitle']) : undefined,
      };
    });
  }

  /** GET /api/dashboards/uid/<uid> — returns the .dashboard object. */
  async getDashboard(uid: string, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.baseUrl}/api/dashboards/uid/${encodeURIComponent(uid)}`;
    const raw = await this.getJson(url, signal);
    const r = raw as Record<string, unknown>;
    return r['dashboard'];
  }

  /**
   * GET /api/datasources/proxy/uid/<dsUid>/api/v1/query_range
   * Returns the raw Prometheus response object.
   */
  async datasourceRange(
    dsUid: string,
    expr: string,
    startSecs: number,
    endSecs: number,
    stepSecs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const qs = new URLSearchParams({
      query: expr,
      start: String(startSecs),
      end: String(endSecs),
      step: String(stepSecs),
    });
    const url = `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(dsUid)}/api/v1/query_range?${qs.toString()}`;
    const raw = await this.getJson(url, signal);
    const r = raw as Record<string, unknown>;
    if (r['status'] === 'error') {
      const errMsg = typeof r['error'] === 'string' ? r['error'] : 'unknown error';
      // Upstream-controlled string — redact before it rides on a thrown Error.
      throw new Error(`Prometheus datasource error: ${redactSecrets(errMsg)}`);
    }
    return raw;
  }

  /**
   * GET /api/datasources/proxy/uid/<dsUid>/api/v1/query
   * Returns the raw Prometheus instant query response.
   */
  async datasourceInstant(
    dsUid: string,
    expr: string,
    timeSecs?: number,
  ): Promise<unknown> {
    const qs = new URLSearchParams({ query: expr });
    if (timeSecs !== undefined) {
      qs.set('time', String(timeSecs));
    }
    const url = `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(dsUid)}/api/v1/query?${qs.toString()}`;
    const raw = await this.getJson(url);
    const r = raw as Record<string, unknown>;
    if (r['status'] === 'error') {
      const errMsg = typeof r['error'] === 'string' ? r['error'] : 'unknown error';
      // Upstream-controlled string — redact before it rides on a thrown Error.
      throw new Error(`Prometheus datasource error: ${redactSecrets(errMsg)}`);
    }
    return raw;
  }
}
