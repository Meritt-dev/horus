/**
 * Read-only MongoDB access for the state-evidence provider (HOR-33).
 *
 * Safety: only read operations are exposed (count / sample / aggregate), every
 * call is gated by an allowlist of collections, and the connection is opened
 * with a read preference. There is no write surface on this client.
 */

import { MongoClient, type Document } from 'mongodb';
import type { HealthStatus } from '@horus/core';
import { redactErrorMessage } from '@horus/core';

export interface MongoClientOpts {
  url: string;
  database: string;
  /** Only these collections may be queried. */
  allowlist: string[];
}

export class MongoStateClient {
  private client: MongoClient | null = null;

  constructor(private readonly opts: MongoClientOpts) {}

  private assertAllowed(collection: string): void {
    if (this.opts.allowlist.length === 0) return; // empty = auto-discover mode, all collections permitted
    if (!this.opts.allowlist.includes(collection)) {
      throw new Error(
        `Collection "${collection}" is not allowlisted for ${this.opts.database}`,
      );
    }
  }

  /** List all collection names in the configured database (for auto-discovery). */
  async listCollections(): Promise<string[]> {
    const db = await this.db();
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    return cols.map((c) => c['name'] as string).filter(Boolean);
  }

  private async db() {
    if (this.client === null) {
      this.client = new MongoClient(this.opts.url, {
        serverSelectionTimeoutMS: 5000,
        readPreference: 'secondaryPreferred',
      });
      await this.client.connect();
    }
    return this.client.db(this.opts.database);
  }

  /** Exact document count for a collection (optionally filtered). */
  async count(collection: string, filter: Document = {}): Promise<number> {
    this.assertAllowed(collection);
    return (await this.db()).collection(collection).countDocuments(filter);
  }

  /** Field names from the most recent document (for field-shape detection). */
  async sampleFields(collection: string): Promise<string[]> {
    this.assertAllowed(collection);
    const doc = await (await this.db())
      .collection(collection)
      .findOne({}, { sort: { _id: -1 }, projection: {} });
    return doc ? Object.keys(doc) : [];
  }

  /** Count documents grouped by a string field (top `limit` values). */
  async groupBy(
    collection: string,
    field: string,
    limit = 25,
  ): Promise<Array<{ value: string; count: number }>> {
    this.assertAllowed(collection);
    const rows = await (await this.db())
      .collection(collection)
      .aggregate([
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
      ])
      .toArray();
    return rows.map((r) => ({
      value: r['_id'] === null || r['_id'] === undefined ? '(none)' : String(r['_id']),
      count: typeof r['count'] === 'number' ? r['count'] : 0,
    }));
  }

  /** ISO timestamp of the newest value of a date field, or null. */
  async maxDate(collection: string, field: string): Promise<string | null> {
    this.assertAllowed(collection);
    const doc = await (await this.db())
      .collection(collection)
      .find({ [field]: { $type: 'date' } })
      .project({ [field]: 1 })
      .sort({ [field]: -1 })
      .limit(1)
      .next();
    const v = doc?.[field];
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') return v;
    return null;
  }

  async health(): Promise<HealthStatus> {
    try {
      const db = await this.db();
      await db.command({ ping: 1 });
      return { ok: true, detail: `mongodb ${this.opts.database} reachable` };
    } catch (err) {
      // Driver errors (MongoParseError, server selection) can echo the URI creds.
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }

  async close(): Promise<void> {
    if (this.client !== null) {
      await this.client.close();
      this.client = null;
    }
  }
}
