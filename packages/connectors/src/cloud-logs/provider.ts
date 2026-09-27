import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets, redactErrorMessage, type HealthStatus } from '@horus/core';
import type { Provider } from '../contract.js';
import type { AxiomLogRecord } from '../axiom/client.js';
import { fetchWithRetry } from '../http.js';
import { nativeJson } from './native-cli.js';

import { cloudLogSchemas, type CloudLogKind, type CloudLogConfig } from '@horus/core';
export interface StructuredLogSource extends Provider {
  collect(opts?: {
    from?: string;
    to?: string;
    hintTerms?: string[];
  }): Promise<AxiomLogRecord[]>;
}
const rowSchema = z.record(z.unknown());
const arraySchema = z.array(rowSchema);
function time(value: unknown): string | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(n) && Number.isFinite(new Date(n).getTime())
    ? new Date(n).toISOString()
    : undefined;
}
/** Keep incident fields, not arbitrary cloud payloads or access tokens. */
export function cloudLogRecord(
  source: string,
  row: Record<string, unknown>,
): AxiomLogRecord {
  let nested: Record<string, unknown> = {};
  const rawMessage = [
    row.message,
    row.Message,
    row.Log_s,
    row.RenderedDescription,
    row.textPayload,
    row.OuterMessage,
  ].find((v) => typeof v === 'string' && v.length > 0);
  if (typeof rawMessage === 'string') {
    try {
      nested = rowSchema.parse(JSON.parse(rawMessage));
    } catch {
      /* plain text */
    }
  }
  const data = {
    ...row,
    ...(typeof row.jsonPayload === 'object' ? row.jsonPayload : {}),
    ...nested,
  } as Record<string, unknown>;
  const rawLevel = data.level ?? data.severity ?? data.SeverityLevel;
  const message = redactSecrets(
    String(
      [data.message, data.msg, rawMessage].find(
        (v) => typeof v === 'string' && v.length > 0,
      ) ?? '(log event)',
    ),
  )
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .slice(0, 8000);
  // Only explicit severity is authoritative. "Turn this warning into an error" is not an error.
  const textLevel = /\[(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\]/i.exec(
    message,
  )?.[1];
  let level =
    typeof rawLevel === 'number'
      ? typeof data.SeverityLevel === 'number' && data.level === undefined
        ? rawLevel >= 3
          ? 'error'
          : rawLevel === 2
            ? 'warn'
            : 'info'
        : rawLevel >= 50
          ? 'error'
          : rawLevel >= 40
            ? 'warn'
            : 'info'
      : String(rawLevel ?? textLevel ?? 'info').toLowerCase();
  if (level === 'warning') level = 'warn';
  if (['alert', 'emergency'].includes(level)) level = 'critical';
  const fields: Record<string, unknown> = {
    source,
    message,
    level,
    eventId: String(
      data.insertId ??
        data.eventId ??
        createHash('sha256').update(JSON.stringify(row)).digest('hex'),
    ),
    service: redactSecrets(
      String(
        [data.service_name, data.service, data.AppRoleName, data.ContainerAppName_s].find(
          (v) => typeof v === 'string' && v.length > 0,
        ) ?? '',
      ),
    ),
  };
  for (const key of [
    'event_code',
    'errorCode',
    'orderId',
    'workflow',
    'correlationId',
    'traceId',
    'requestId',
  ]) {
    if (typeof data[key] === 'string')
      fields[key] = redactSecrets(data[key] as string).slice(0, 500);
  }
  return { timestamp: time(data.timestamp ?? data.TimeGenerated ?? data.time), fields };
}

export class CloudLogsProvider<
  K extends CloudLogKind = CloudLogKind,
> implements StructuredLogSource {
  readonly kind = 'logs' as const;
  readonly config: CloudLogConfig[K];
  constructor(
    readonly id: K,
    config: CloudLogConfig[K],
  ) {
    this.config = cloudLogSchemas[id].parse(config) as CloudLogConfig[K];
  }
  async collect(
    opts: { from?: string; to?: string; hintTerms?: string[] } = {},
  ): Promise<AxiomLogRecord[]> {
    const to = opts.to ?? new Date().toISOString();
    const from = opts.from ?? new Date(Date.parse(to) - 86400_000).toISOString();
    if (
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(from) > Date.parse(to)
    )
      throw new Error('Invalid log time window');
    // ponytail: bounded evidence sample, not a lossless watcher cursor. Native trigger adapters must paginate separately.
    const limit = 200;
    const terms = (opts.hintTerms ?? []).filter((t) => t.length > 2).slice(0, 8);
    let rows: Record<string, unknown>[];
    if (this.id === 'azure-monitor') {
      const c = this.config as CloudLogConfig['azure-monitor'];
      const body = `union isfuzzy=true ${c.tables.join(', ')} | where TimeGenerated between (datetime(${new Date(from).toISOString()}) .. datetime(${new Date(to).toISOString()})) | extend HorusText=tostring(pack_all())${terms.length ? ` | where ${terms.map((t) => `HorusText contains ${JSON.stringify(t)}`).join(' or ')}` : ''} | order by TimeGenerated desc | take ${limit}`;
      // az rest can choose the default tenant even with --subscription. Bind the token explicitly.
      const auth = z
        .object({ accessToken: z.string().min(1) })
        .parse(
          await nativeJson(c.executable, [
            'account',
            'get-access-token',
            '--resource',
            'https://api.loganalytics.io',
            ...(c.subscription ? ['--subscription', c.subscription] : []),
            '--output',
            'json',
          ]),
        );
      const response = await fetchWithRetry(
        `https://api.loganalytics.azure.com/v1/workspaces/${c.workspace}/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: body }),
        },
        { timeoutMs: 30000 },
      );
      if (!response.ok) throw new Error(`Azure Monitor HTTP ${response.status}`);
      const raw: unknown = await response.json();
      const result = z
        .object({
          tables: z.array(
            z.object({
              columns: z.array(z.object({ name: z.string() })),
              rows: z.array(z.array(z.unknown())),
            }),
          ),
          error: z.unknown().optional(),
        })
        .parse(raw);
      if (result.error)
        throw new Error(
          'Azure Monitor returned partial/error results; inspect workspace query access',
        );
      rows = result.tables.flatMap((t) =>
        t.rows.map((r) =>
          Object.fromEntries(t.columns.map((col, i) => [col.name, r[i]])),
        ),
      );
    } else if (this.id === 'cloudwatch') {
      const c = this.config as CloudLogConfig['cloudwatch'];
      rows = [];
      let next: string | undefined;
      for (let page = 0; page < 5 && rows.length < limit; page++) {
        const raw = await nativeJson(c.executable, [
          'logs',
          'filter-log-events',
          '--region',
          c.region,
          '--log-group-name',
          c.logGroup,
          '--start-time',
          String(Date.parse(from)),
          '--end-time',
          String(Date.parse(to)),
          '--limit',
          String(limit - rows.length),
          '--no-paginate',
          '--no-cli-pager',
          '--output',
          'json',
          ...(c.profile ? ['--profile', c.profile] : []),
          ...(terms.length
            ? ['--filter-pattern', terms.map((t) => '?' + JSON.stringify(t)).join(' ')]
            : []),
          ...(next ? ['--next-token', next] : []),
        ]);
        const result = z
          .object({ events: arraySchema, nextToken: z.string().optional() })
          .parse(raw);
        rows.push(...result.events);
        if (!result.nextToken || result.nextToken === next) break;
        next = result.nextToken;
      }
    } else {
      const c = this.config as CloudLogConfig['gcp-logging'];
      const filter = [
        `timestamp >= ${JSON.stringify(new Date(from).toISOString())}`,
        `timestamp <= ${JSON.stringify(new Date(to).toISOString())}`,
        c.filter && `(${c.filter})`,
        terms.length && `(${terms.map((t) => JSON.stringify(t)).join(' OR ')})`,
      ]
        .filter(Boolean)
        .join(' AND ');
      rows = arraySchema.parse(
        await nativeJson(c.executable, [
          'logging',
          'read',
          filter,
          '--project',
          c.project,
          '--limit',
          String(limit),
          '--order',
          'desc',
          '--format',
          'json',
          '--quiet',
        ]),
      );
    }
    return rows.map((r) => cloudLogRecord(this.id, r));
  }
  async health(): Promise<HealthStatus> {
    try {
      const now = new Date().toISOString();
      await this.collect({ from: new Date(Date.now() - 60_000).toISOString(), to: now });
      return { ok: true, detail: `${this.id}: read access verified` };
    } catch (error) {
      return { ok: false, detail: redactErrorMessage(error) };
    }
  }
}
