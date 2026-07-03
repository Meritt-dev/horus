/**
 * Read-only Postgres access for the state-evidence provider (HOR-CONNECTORS).
 *
 * Safety: only read operations are exposed (count / columns / aggregate / max), the
 * session is pinned to `default_transaction_read_only = on` with a statement timeout,
 * every call is gated by an allowlist of tables, and identifiers are validated before
 * interpolation (parameters can't be used for table/column names in Postgres). There
 * is no write surface on this client.
 */

import pg from 'pg';
import type { HealthStatus } from '@horus/core';
import { redactErrorMessage } from '@horus/core';
import type { StateClient } from '../state/provider.js';
import type { StatusCount } from '../state/analyze.js';

const { Client } = pg;

export interface PostgresClientOpts {
  /** Connection string, e.g. postgres://user:pass@host:5432/db */
  url: string;
  /** Schema to introspect (default: "public"). */
  schema?: string;
  /** Only these tables may be queried (empty = auto-discover, all permitted). */
  allowlist: string[];
}

/** Reject anything that isn't a plain SQL identifier — table/column names can't be parameterized. */
export function quoteIdent(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(id)) {
    throw new Error(`Unsafe SQL identifier: ${id}`);
  }
  return `"${id}"`;
}

export class PostgresStateClient implements StateClient {
  private client: InstanceType<typeof Client> | null = null;

  constructor(private readonly opts: PostgresClientOpts) {}

  private get schema(): string {
    return this.opts.schema ?? 'public';
  }

  private assertAllowed(table: string): void {
    if (this.opts.allowlist.length === 0) return; // empty = auto-discover mode
    if (!this.opts.allowlist.includes(table)) {
      throw new Error(`Table "${table}" is not allowlisted`);
    }
  }

  private async conn(): Promise<InstanceType<typeof Client>> {
    if (this.client === null) {
      const client = new Client({
        connectionString: this.opts.url,
        connectionTimeoutMillis: 5000,
        statement_timeout: 8000,
        query_timeout: 8000,
        application_name: 'horus-readonly',
      });
      await client.connect();
      // Belt-and-braces: pin the session read-only so no statement can mutate.
      await client.query('SET default_transaction_read_only = on');
      this.client = client;
    }
    return this.client;
  }

  /** Base tables in the configured schema (StateClient: "collections" === tables). */
  async listCollections(): Promise<string[]> {
    const c = await this.conn();
    const res = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [this.schema],
    );
    return res.rows.map((r) => r.table_name as string).filter(Boolean);
  }

  async count(table: string): Promise<number> {
    this.assertAllowed(table);
    const c = await this.conn();
    const res = await c.query(`SELECT COUNT(*)::bigint AS n FROM ${quoteIdent(this.schema)}.${quoteIdent(table)}`);
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Column names (StateClient: "fields" === columns) — for date/status field detection. */
  async sampleFields(table: string): Promise<string[]> {
    this.assertAllowed(table);
    const c = await this.conn();
    const res = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [this.schema, table],
    );
    return res.rows.map((r) => r.column_name as string).filter(Boolean);
  }

  async maxDate(table: string, field: string): Promise<string | null> {
    this.assertAllowed(table);
    const c = await this.conn();
    const res = await c.query(
      `SELECT MAX(${quoteIdent(field)}) AS m FROM ${quoteIdent(this.schema)}.${quoteIdent(table)}`,
    );
    const v = res.rows[0]?.m;
    if (v === null || v === undefined) return null;
    return v instanceof Date ? v.toISOString() : String(v);
  }

  async groupBy(table: string, field: string, limit = 25): Promise<StatusCount[]> {
    this.assertAllowed(table);
    const c = await this.conn();
    const res = await c.query(
      `SELECT ${quoteIdent(field)}::text AS value, COUNT(*)::bigint AS count
       FROM ${quoteIdent(this.schema)}.${quoteIdent(table)}
       GROUP BY 1 ORDER BY 2 DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    );
    return res.rows.map((r) => ({
      value: r.value === null || r.value === undefined ? '(none)' : String(r.value),
      count: Number(r.count) || 0,
    }));
  }

  async health(): Promise<HealthStatus> {
    try {
      const c = await this.conn();
      await c.query('SELECT 1');
      return { ok: true, detail: 'postgres reachable' };
    } catch (err) {
      // node-postgres connection failures can wrap the credential-bearing URL.
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }

  async close(): Promise<void> {
    if (this.client !== null) {
      await this.client.end();
      this.client = null;
    }
  }
}
