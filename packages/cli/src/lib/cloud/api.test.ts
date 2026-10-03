import { afterEach, expect, it, vi } from 'vitest';
import { CloudClient, CloudError } from './api.js';

afterEach(() => vi.unstubAllGlobals());
it('preserves rate limits through non-JSON gateway errors and ignores malformed Retry-After', async () => {
  for (const [header, expected] of [
    ['120', 120000],
    ['invalid', undefined],
  ] as const) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('upstream busy', {
            status: 429,
            headers: { 'Retry-After': header },
          }),
      ),
    );
    const error = await new CloudClient('http://localhost', 'test-token')
      .me()
      .catch((e) => e);
    expect(error).toBeInstanceOf(CloudError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(expected);
  }
});

it('sends a report notification checkpoint through Cloud without a Slack credential', async () => {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ state: 'off' })),
  );
  vi.stubGlobal('fetch', fetch);
  const input = {
    notificationKey: 'job:report',
    hint: 'Timeout',
    cause: 'Cause uncertain',
    confidence: 0,
  };
  expect(
    await new CloudClient('https://api.horus.test', 'cloud-token').notifyInvestigation(
      'project',
      'report',
      input,
    ),
  ).toEqual({ state: 'off' });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    'https://api.horus.test/v1/projects/project/investigations/report/notify',
  );
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
});
