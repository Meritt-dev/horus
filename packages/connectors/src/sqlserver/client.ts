import sql from 'mssql';
import { runtimeSchemas, redactErrorMessage, type RuntimeConfig } from '@horus/core';
import type { StateClient } from '../state/provider.js';
export function sqlIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name))
    throw new Error('Unsafe SQL Server identifier');
  return `[${name}]`;
}
/** Fixed SELECTs only. Use a SELECT-only SQL login; readOnlyIntent is routing, not authorization. */
export class SqlServerStateClient implements StateClient {
  readonly config: RuntimeConfig['sqlserver'];
  private pool?: sql.ConnectionPool;
  constructor(config: RuntimeConfig['sqlserver']) {
    this.config = runtimeSchemas.sqlserver.parse(config);
  }
  private async conn() {
    if (!this.pool) {
      if (!this.config.url) throw new Error('SQL Server URL is not configured');
      const config = sql.ConnectionPool.parseConnectionString(this.config.url);
      const pool = new sql.ConnectionPool({
        ...config,
        database: this.config.database,
        connectionTimeout: 5000,
        requestTimeout: 8000,
        pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
        options: { ...config.options, readOnlyIntent: true, appName: 'horus-readonly' },
      });
      try {
        await pool.connect();
        this.pool = pool;
      } catch (e) {
        await pool.close().catch(() => {});
        throw new Error(redactErrorMessage(e));
      }
    }
    return this.pool;
  }
  private table(name: string) {
    if (!this.config.tables.includes(name)) throw new Error('Table is not allowlisted');
    return `${sqlIdentifier(this.config.schema)}.${sqlIdentifier(name)}`;
  }
  async listCollections() {
    return [...this.config.tables];
  }
  async count(table: string) {
    const name = this.table(table);
    const r = await (await this.conn())
      .request()
      .query(`SELECT COUNT_BIG(*) AS n FROM ${name}`);
    const n = Number(r.recordset[0]?.n);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid row count');
    return n;
  }
  async sampleFields(table: string): Promise<string[]> {
    this.table(table);
    const r = await (await this.conn())
      .request()
      .input('schema', sql.NVarChar, this.config.schema)
      .input('table', sql.NVarChar, table)
      .query(
        'SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table',
      );
    return r.recordset.map((x) => String(x.name));
  }
  async maxDate(table: string, field: string) {
    const name = this.table(table);
    const r = await (await this.conn())
      .request()
      .query(`SELECT MAX(${sqlIdentifier(field)}) AS value FROM ${name}`);
    const v = r.recordset[0]?.value;
    if (v == null) return null;
    const date = new Date(v);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  async groupBy(table: string, field: string) {
    const name = this.table(table);
    const column = sqlIdentifier(field);
    const r = await (await this.conn())
      .request()
      .query(
        `SELECT TOP (25) ${column} AS value, COUNT_BIG(*) AS count FROM ${name} GROUP BY ${column} ORDER BY COUNT_BIG(*) DESC`,
      );
    return r.recordset.map((x) => ({
      value: x.value == null ? '(none)' : String(x.value).slice(0, 200),
      count: Number(x.count),
    }));
  }
  async health() {
    try {
      await (await this.conn()).request().query('SELECT 1 AS ok');
      return { ok: true, detail: 'SQL Server read connection verified' };
    } catch (e) {
      return { ok: false, detail: redactErrorMessage(e) };
    }
  }
  async close() {
    await this.pool?.close();
    this.pool = undefined;
  }
}
