/** Read-only seven-day ES replay through the canonical event/episode store. No AI or Cloud writes. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loadConfig, resolveEnvironment } from '../packages/core/src/index.js';
import { logsForEnv } from '../packages/connectors/src/index.js';
import { createLocalDb } from '../packages/db/src/index.js';
import { elasticEvent } from '../packages/cli/src/lib/watch-service.js';
import {
  acceptEvents,
  jobs,
  type IncidentEvent,
} from '../packages/cli/src/lib/watch-store.js';

const config = process.env.HORUS_LIVE_CONFIG;
assert(config && isAbsolute(config), 'Absolute HORUS_LIVE_CONFIG required');
const env = resolveEnvironment(await loadConfig(config), {
  env: process.env.HORUS_LIVE_ENV,
});
assert(env.readOnly, 'Read-only environment required');
const logs = logsForEnv(env);
assert(logs, 'Configured Elasticsearch connector required');
const dayMs = 86400_000;
const end = Date.parse(
  process.env.HORUS_VOLUME_END ?? new Date().toISOString().slice(0, 10) + 'T00:00:00Z',
);
assert(
  Number.isFinite(end) && end <= Date.now(),
  'Valid historical HORUS_VOLUME_END required',
);
const start = end - 7 * dayMs;
const dir = await mkdtemp(join(tmpdir(), 'horus-volume-'));
const db = await createLocalDb({ path: join(dir, 'db') });
const seen = new Set<string>();
const daily: Array<{ from: string; to: string; events: number; episodes: number }> = [];
let requests = 0;
let firstEvent: IncidentEvent | undefined;
let lastEvent: IncidentEvent | undefined;
try {
  async function collect(from: number, to: number): Promise<number> {
    assert(++requests <= 1000, 'Query cap reached; volume estimate incomplete');
    const records = await logs!.searchLogs({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      level: 'error',
      service: env.connectors.elasticsearch?.serviceName,
      limit: 1000,
    });
    if (records.length >= 1000) {
      assert(
        to - from > 1000,
        'Dense window exceeds provider limit; volume estimate incomplete',
      );
      const middle = Math.floor((from + to) / 2);
      // Sequential, chronological ingestion preserves the service's quiet-hour episode boundaries.
      return (await collect(from, middle)) + (await collect(middle + 1, to));
    }
    const events = records
      .map((r) => elasticEvent(r, env.env))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
      .filter((event) => {
        assert(
          Date.parse(event.occurredAt) >= from && Date.parse(event.occurredAt) <= to,
          'Provider returned an out-of-window event',
        );
        if (seen.has(event.eventId)) return false;
        seen.add(event.eventId);
        return true;
      });
    assert(seen.size <= 20000, 'Event cap reached; volume estimate incomplete');
    firstEvent ??= events[0];
    lastEvent = events.at(-1) ?? lastEvent;
    await acceptEvents(db.db, 'volume-replay', events);
    return events.length;
  }
  let previousEpisodes = 0;
  for (let from = start; from < end; from += dayMs) {
    const to = from + dayMs - 1;
    const events = await collect(from, to);
    const count = (await jobs(db.db, 'volume-replay')).length;
    const row = {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      events,
      episodes: count - previousEpisodes,
    };
    daily.push(row);
    previousEpisodes = count;
    console.error(JSON.stringify(row));
  }
  // Replay-delivery check exercises the actual ledger rather than an analysis-only dedupe approximation.
  await acceptEvents(
    db.db,
    'volume-replay',
    [firstEvent, lastEvent].filter((e): e is IncidentEvent => !!e),
  );
  const episodes = await jobs(db.db, 'volume-replay');
  assert.equal(
    episodes.length,
    previousEpisodes,
    'Duplicate replay created another episode',
  );
  assert.equal(
    daily.reduce((n, d) => n + d.events, 0),
    seen.size,
  );
  assert.equal(
    daily.reduce((n, d) => n + d.episodes, 0),
    episodes.length,
  );
  console.log(
    JSON.stringify(
      {
        project: env.project,
        environment: env.env,
        source: 'elasticsearch',
        from: new Date(start).toISOString(),
        toExclusive: new Date(end).toISOString(),
        measuredAt: new Date().toISOString(),
        requests,
        events: seen.size,
        episodes: episodes.length,
        daily,
        peakDailyEpisodes: Math.max(...daily.map((d) => d.episodes)),
        criticalEpisodes: episodes.filter(
          (j) => (j.latestEvent ?? j.event).severity === 'critical',
        ).length,
        duplicateReplayAddedEpisodes: 0,
        limits: [
          'Available indexed error-level logs only; upstream retention is not proven.',
          'First-day episodes may have begun before the measurement window.',
          'Canonical ES fallback grouping; not native PagerDuty alert volume or model cost.',
          'No inference, notifications, Cloud writes, or live local database access.',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await db.sql.end();
  await rm(dir, { recursive: true, force: true });
}
