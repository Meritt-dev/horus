/**
 * Shared state-provider contract (HOR-33 / HOR-CONNECTORS). A "state provider"
 * surfaces application STATE anomalies (stale sync records, failed/stuck states)
 * as Evidence — never raw records. MongoDB and Postgres both implement it; the
 * analysis loop is shared via `analyzeStateWith` so each provider only supplies a
 * read-only `StateClient`.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import type { Provider } from '../contract.js';
import {
  type StateAnalysis,
  type CollectionState,
  type StatusCount,
  DATE_FIELDS,
  STATUS_FIELDS,
  DEFAULT_LEGACY_HOURS,
  pickField,
  isAnomalousStatus,
  ageHoursOf,
  classifyAge,
} from './analyze.js';

export interface StateProvider extends Provider {
  readonly kind: ProviderKind;
  analyzeState(opts?: { staleHours?: number; legacyHours?: number }): Promise<StateAnalysis>;
  toEvidence(analysis: StateAnalysis): Evidence[];
  /** List containers (collections/tables) in the configured database. */
  listCollections?(): Promise<string[]>;
  health(): Promise<HealthStatus>;
  /** Close the underlying connection so the process can exit. */
  close(): Promise<void>;
}

/**
 * Read-only datastore access used by `analyzeStateWith`. Method names are storage-
 * neutral despite the Mongo lineage: for Postgres, `listCollections` returns tables
 * and `sampleFields` returns column names. There is no write surface here.
 */
export interface StateClient {
  /** Container names in the database (collections / tables), for auto-discovery. */
  listCollections(): Promise<string[]>;
  /** Record count for a container. */
  count(container: string): Promise<number>;
  /** Field/column names for a container (for date/status field detection). */
  sampleFields(container: string): Promise<string[]>;
  /** ISO timestamp of the newest value of a date field, or null. */
  maxDate(container: string, field: string): Promise<string | null>;
  /** Record counts grouped by a string field (top values). */
  groupBy(container: string, field: string): Promise<StatusCount[]>;
}

/**
 * Shared analysis loop: count + date-age + status-bucket each container, classify
 * staleness, and flag anomalous status buckets. A single bad/missing container is
 * skipped, never aborting the whole analysis — but when EVERY container fails the
 * first error is rethrown: a completely-down database must reach the engine as a
 * failure, not as a clean empty analysis. (Auto-discovery already throws on a down
 * DB via listCollections.)
 */
export async function analyzeStateWith(
  client: StateClient,
  opts: { database: string; collections: string[]; staleHours: number; legacyHours?: number },
  nowMs: number,
): Promise<StateAnalysis> {
  const staleHours = opts.staleHours;
  const legacyHours = opts.legacyHours ?? DEFAULT_LEGACY_HOURS;
  const collections: CollectionState[] = [];
  let firstError: unknown;

  let targets = opts.collections;
  let autoDiscovered = false;
  if (targets.length === 0) {
    targets = await client.listCollections();
    autoDiscovered = true;
  }

  for (const coll of targets) {
    try {
      const count = await client.count(coll);
      const fields = await client.sampleFields(coll);
      const cs: CollectionState = {
        collection: coll,
        count,
        classification: 'unknown',
        anomalies: [],
      };

      const dateField = pickField(fields, DATE_FIELDS);
      if (dateField !== undefined) {
        const last = await client.maxDate(coll, dateField);
        if (last !== null) {
          cs.dateField = dateField;
          cs.lastActivity = last;
          cs.ageHours = ageHoursOf(last, nowMs);
          cs.isStale = cs.ageHours > staleHours;
        }
      }
      cs.classification = classifyAge(cs.ageHours, staleHours, legacyHours);

      const statusField = pickField(fields, STATUS_FIELDS);
      if (statusField !== undefined) {
        const counts = await client.groupBy(coll, statusField);
        cs.statusField = statusField;
        cs.statusCounts = counts;
        cs.anomalies = counts.filter((c) => isAnomalousStatus(c.value));
      }

      collections.push(cs);
    } catch (err) {
      // A single bad/missing container must not abort the whole analysis.
      firstError ??= err;
    }
  }

  if (targets.length > 0 && collections.length === 0 && firstError !== undefined) {
    throw firstError;
  }
  return { database: opts.database, staleHours, legacyHours, collections, autoDiscovered };
}
