import { it, expect, vi, afterEach } from 'vitest';
import { offsetLag } from './runtime-queue/provider.js';
import { sqlIdentifier, SqlServerStateClient } from './sqlserver/client.js';
import { FirestoreStateClient } from './firestore/client.js';
import { PrometheusMetricsProvider } from './prometheus/provider.js';
import { runtimeSchemas } from '@horus/core';
afterEach(() => vi.unstubAllGlobals());
it('never rounds Kafka offsets or invents lag for unknown/reset offsets', () => {
  expect(offsetLag('9007199254740999', '9007199254740993')).toBe('6');
  for (const value of [undefined, '-1', 'bad', '9007199254741000'])
    expect(offsetLag('9007199254740999', value)).toBeNull();
});
it('bounds datastore scope and rejects unsafe identifiers before any I/O', async () => {
  expect(() =>
    runtimeSchemas.firestore.parse({ project: 'project-a', collections: [] }),
  ).toThrow();
  expect(() => sqlIdentifier('orders]; DELETE FROM orders;--')).toThrow();
  const sql = new SqlServerStateClient({
    url: 'Server=localhost;Database=test',
    database: 'test',
    schema: 'dbo',
    tables: ['orders'],
  });
  await expect(sql.count('customers')).rejects.toThrow('allowlisted');
  const fs = new FirestoreStateClient({
    project: 'project-a',
    database: '(default)',
    collections: ['users/one/invoices'],
    executable: 'gcloud',
  });
  await expect(fs.count('users')).rejects.toThrow('allowlisted');
  await expect(fs.maxDate('users/one/invoices', 'privateNotes')).rejects.toThrow(
    'Unsupported',
  );
});
it('direct Prometheus uses the existing analyzer with bounded query windows and HTTP failures', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { service: 'orders' },
              values: [
                [100, '2'],
                [160, '4'],
              ],
            },
          ],
        },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const p = new PrometheusMetricsProvider({
    url: 'https://metrics.example',
    queries: [{ title: 'order latency', expr: 'orders_duration_seconds' }],
  });
  expect((await p.rawRange('up', 0, 1000000))[0]?.samples).toHaveLength(2);
  expect(new URL(fetch.mock.calls[0]![0]).searchParams.get('step')).toBe('1000');
  fetch.mockImplementation(() => Promise.resolve(new Response('', { status: 403 })));
  expect((await p.health()).ok).toBe(false);
});
