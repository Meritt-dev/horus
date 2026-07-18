import { describe, it, expect } from 'vitest';
import {
  buildErrorAnalysisBody,
  parseErrorAnalysis,
  annotateAgainstBaseline,
  analysisToEvidence,
  shortTs,
  type LogAnalysis,
} from './analyze.js';
import { MERITT_FIELD_MAPPING, ECS_FIELD_MAPPING } from './normalize.js';

describe('shortTs', () => {
  it('formats an ISO timestamp as MM-DD HH:MM', () => {
    expect(shortTs('2026-06-13T15:36:50.279Z')).toBe('06-13 15:36');
  });
  it('is empty-safe', () => {
    expect(shortTs('')).toBe('—');
  });
});

describe('buildErrorAnalysisBody (Meritt mapping)', () => {
  it('builds an error agg with first/last/services sub-aggs on keyword fields', () => {
    const body = buildErrorAnalysisBody(
      {
        service: 'leadcall-api-prod',
        from: '2026-06-07T00:00:00Z',
        to: '2026-06-14T00:00:00Z',
      },
      'event_code',
      MERITT_FIELD_MAPPING,
    );
    expect(body['size']).toBe(0);
    expect(body['track_total_hits']).toBe(true);

    const query = body['query'] as Record<string, unknown>;
    const bool = query['bool'] as Record<string, unknown>;
    const filters = JSON.stringify(bool['filter']);
    // Meritt: numeric level >= 50
    expect(filters).toContain('"level":{"gte":50}');
    expect(filters).toContain('service_name.keyword');
    expect(filters).toContain('time');

    const aggs = body['aggs'] as Record<string, unknown>;
    const bySig = aggs['by_sig'] as Record<string, unknown>;
    expect((bySig['terms'] as Record<string, unknown>)['field']).toBe('event_code.keyword');
    const subAggs = JSON.stringify(bySig['aggs']);
    expect(subAggs).toContain('first_seen');
    expect(subAggs).toContain('last_seen');
    expect(subAggs).toContain('service_name.keyword');
    // timestamp field used for first/last and sort
    expect(subAggs).toContain('"time"');
    expect(JSON.stringify(aggs['affected_services'])).toContain('service_name.keyword');
  });

  it('omits the event_code term filter when q.eventCode is unset', () => {
    const body = buildErrorAnalysisBody(
      { service: 'leadcall-api-prod', from: '2026-06-07T00:00:00Z' },
      'event_code',
      MERITT_FIELD_MAPPING,
    );
    const bool = (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>;
    const filters = JSON.stringify(bool['filter']);
    // No term clause on the signature field when the join code isn't requested.
    expect(filters).not.toContain('"event_code.keyword":"');
  });

  it('emits an event_code.keyword term filter when q.eventCode is set (cross-signal join)', () => {
    const body = buildErrorAnalysisBody(
      { service: 'leadcall-api-prod', from: '2026-06-07T00:00:00Z', eventCode: 'HTTPFLT001' },
      'event_code',
      MERITT_FIELD_MAPPING,
    );
    const bool = (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>;
    const filters = bool['filter'] as Array<Record<string, unknown>>;
    const termClause = filters.find(
      (f) =>
        f['term'] !== undefined &&
        (f['term'] as Record<string, unknown>)['event_code.keyword'] === 'HTTPFLT001',
    );
    expect(termClause).toBeDefined();
    // The aggregation still keys on the same keyword field.
    const aggs = body['aggs'] as Record<string, unknown>;
    const bySig = aggs['by_sig'] as Record<string, unknown>;
    expect((bySig['terms'] as Record<string, unknown>)['field']).toBe('event_code.keyword');
  });

  it('omits the error-level floor when q.eventCode is set (GAP-1: INFO/WARN codes are visible)', () => {
    // A specific event_code lookup must match regardless of log level — leadcall's
    // CLGRES005 is INFO with live occurrences and the error floor made it invisible.
    const body = buildErrorAnalysisBody(
      { service: 'leadcall-api-prod', from: '2026-06-07T00:00:00Z', eventCode: 'CLGRES005' },
      'event_code',
      MERITT_FIELD_MAPPING,
    );
    const bool = (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>;
    const filters = JSON.stringify(bool['filter']);
    // No error-level floor — the code term keys the lookup on its own.
    expect(filters).not.toContain('"level":{"gte":50}');
    // But the event_code term is still present.
    expect(filters).toContain('"event_code.keyword":"CLGRES005"');
  });

  it('keeps the error-level floor for the unfiltered top-N aggregation (no eventCode)', () => {
    const body = buildErrorAnalysisBody(
      { service: 'leadcall-api-prod', from: '2026-06-07T00:00:00Z' },
      'event_code',
      MERITT_FIELD_MAPPING,
    );
    const bool = (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>;
    const filters = JSON.stringify(bool['filter']);
    expect(filters).toContain('"level":{"gte":50}');
  });

  it('lowers the floor to warn ONLY when a hint-text query scopes it (HOR-453)', () => {
    const scoped = buildErrorAnalysisBody(
      { service: 'svc', from: '2026-06-07T00:00:00Z', level: 'warn', text: 'sale link not found' },
      'event_code',
      MERITT_FIELD_MAPPING,
    );
    const scopedFilters = JSON.stringify(
      ((scoped['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>)['filter'],
    );
    expect(scopedFilters).toContain('"level":{"gte":40}');
    // Without text, a below-error level is ignored — the error floor stays (no benign-warn flood).
    const unscoped = buildErrorAnalysisBody(
      { service: 'svc', from: '2026-06-07T00:00:00Z', level: 'warn' },
      'event_code',
      MERITT_FIELD_MAPPING,
    );
    const unscopedFilters = JSON.stringify(
      ((unscoped['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>)['filter'],
    );
    expect(unscopedFilters).toContain('"level":{"gte":50}');
  });

  it('honors an explicit above-error level even on a scoped event_code lookup', () => {
    // A caller deliberately raising the floor above error (e.g. 'fatal') is a narrowing,
    // not the implicit error default — keep it.
    const body = buildErrorAnalysisBody(
      { service: 'svc', from: '2026-06-07T00:00:00Z', eventCode: 'X_CODE_01', level: 'fatal' },
      'event_code',
      MERITT_FIELD_MAPPING,
    );
    const bool = (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>;
    const filters = JSON.stringify(bool['filter']);
    // fatal = 60 → still a level floor present, just above 50.
    expect(filters).toContain('"level":{"gte":60}');
  });

  it('emits an event.code term filter for the ECS mapping (already keyword-typed)', () => {
    const body = buildErrorAnalysisBody(
      { service: 'my-ecs-svc', from: '2026-06-07T00:00:00Z', eventCode: 'E_SYNC_04' },
      'event.code',
      ECS_FIELD_MAPPING,
    );
    const bool = (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>;
    const filters = bool['filter'] as Array<Record<string, unknown>>;
    // ECS event.code has no .keyword sub-field — filter on the bare field.
    const termClause = filters.find(
      (f) =>
        f['term'] !== undefined &&
        (f['term'] as Record<string, unknown>)['event.code'] === 'E_SYNC_04',
    );
    expect(termClause).toBeDefined();
  });
});

describe('buildErrorAnalysisBody (ECS mapping)', () => {
  it('uses @timestamp for first/last/sort and log.level for filter', () => {
    const body = buildErrorAnalysisBody(
      {
        service: 'my-ecs-svc',
        from: '2026-06-07T00:00:00Z',
        to: '2026-06-14T00:00:00Z',
      },
      'event.code',
      ECS_FIELD_MAPPING,
    );

    const query = body['query'] as Record<string, unknown>;
    const bool = query['bool'] as Record<string, unknown>;
    const filtersStr = JSON.stringify(bool['filter']);
    // ECS: string level terms filter (not range)
    expect(filtersStr).toContain('"log.level"');
    expect(filtersStr).not.toContain('"level":{"gte"');
    expect(filtersStr).toContain('"@timestamp"');
    // ECS serviceKeyword: false — service.name is already keyword-typed, no .keyword sub-field
    expect(filtersStr).toContain('"service.name"');
    expect(filtersStr).not.toContain('service.name.keyword');

    const aggs = body['aggs'] as Record<string, unknown>;
    const bySig = aggs['by_sig'] as Record<string, unknown>;
    const subAggsStr = JSON.stringify(bySig['aggs']);
    // sub-aggs use @timestamp for first/last seen and sort
    expect(subAggsStr).toContain('@timestamp');
    expect(subAggsStr).toContain('"service.name"');
    expect(subAggsStr).not.toContain('service.name.keyword');

    expect(JSON.stringify(aggs['affected_services'])).toContain('"service.name"');
    expect(JSON.stringify(aggs['affected_services'])).not.toContain('service.name.keyword');
  });
});

describe('buildErrorAnalysisBody — mapping consistency with buildSearchBody', () => {
  it('uses the same timestamp field as buildSearchBody for the same mapping', () => {
    // Both Meritt agg and Meritt search must reference 'time'
    const analysisBody = buildErrorAnalysisBody({ from: '2026-06-01T00:00:00Z' }, 'event_code', MERITT_FIELD_MAPPING);
    const filtersStr = JSON.stringify(
      ((analysisBody['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>)['filter'],
    );
    expect(filtersStr).toContain('"time"');
    expect(filtersStr).not.toContain('@timestamp');

    // ECS: both must reference '@timestamp'
    const ecsBody = buildErrorAnalysisBody({ from: '2026-06-01T00:00:00Z' }, 'event.code', ECS_FIELD_MAPPING);
    const ecsFiltersStr = JSON.stringify(
      ((ecsBody['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>)['filter'],
    );
    expect(ecsFiltersStr).toContain('@timestamp');
    expect(ecsFiltersStr).not.toContain('"time"');
  });
});

const FIXTURE = {
  hits: { total: { value: 447 } },
  aggregations: {
    by_sig: {
      buckets: [
        {
          key: 'HTTPFLT001',
          doc_count: 438,
          first_seen: { value_as_string: '2026-06-12T14:54:51.727Z' },
          last_seen: { value_as_string: '2026-06-13T15:36:50.279Z' },
          services: { buckets: [{ key: 'leadcall-api-prod' }] },
          sample: {
            hits: {
              hits: [
                {
                  _source: {
                    message: 'Unhandled HTTP request failed (5xx).',
                    component: 'HttpExceptionLoggingFilter',
                  },
                },
              ],
            },
          },
        },
        {
          key: 'ZOHO500',
          doc_count: 9,
          first_seen: { value_as_string: '2026-06-13T10:00:00.000Z' },
          last_seen: { value_as_string: '2026-06-13T12:00:00.000Z' },
          services: { buckets: [{ key: 'leadcall-api-prod' }] },
          sample: { hits: { hits: [{ _source: { message: 'Zoho 500' } }] } },
        },
      ],
    },
    affected_services: { buckets: [{ key: 'leadcall-api-prod' }] },
  },
};

describe('parseErrorAnalysis', () => {
  it('extracts signatures, occurrences, services, totals', () => {
    const a = parseErrorAnalysis(FIXTURE, { from: 'x', to: 'y' });
    expect(a.totalErrors).toBe(447);
    expect(a.signatures).toHaveLength(2);
    const top = a.signatures[0];
    expect(top?.key).toBe('HTTPFLT001');
    expect(top?.count).toBe(438);
    expect(top?.firstSeen).toBe('2026-06-12T14:54:51.727Z');
    expect(top?.lastSeen).toBe('2026-06-13T15:36:50.279Z');
    expect(top?.services).toEqual(['leadcall-api-prod']);
    expect(top?.sampleMessage).toContain('5xx');
    expect(a.affectedServices).toEqual(['leadcall-api-prod']);
  });

  it('is robust to a missing aggregations block', () => {
    const a = parseErrorAnalysis({}, {});
    expect(a.signatures).toEqual([]);
    expect(a.totalErrors).toBe(0);
  });
});

describe('annotateAgainstBaseline', () => {
  it('flags NEW signatures and computes spike ratios', () => {
    const current = parseErrorAnalysis(FIXTURE, {});
    // baseline only had HTTPFLT001 (146x), ZOHO500 is new
    annotateAgainstBaseline(current, [{ key: 'HTTPFLT001', count: 146, firstSeen: '', lastSeen: '', services: [] }]);

    const http = current.signatures.find((s) => s.key === 'HTTPFLT001');
    const zoho = current.signatures.find((s) => s.key === 'ZOHO500');
    expect(http?.isNew).toBe(false);
    expect(http?.ratio).toBeCloseTo(438 / 146, 5); // 3.0
    expect(zoho?.isNew).toBe(true);
    expect(zoho?.ratio).toBe(Infinity);
    expect(current.newSignatures).toEqual(['ZOHO500']);
  });
});

describe('analysisToEvidence', () => {
  it('emits one signature Evidence each + an affected-services summary', () => {
    const current = parseErrorAnalysis(FIXTURE, {});
    annotateAgainstBaseline(current, []); // everything is NEW
    const ev = analysisToEvidence(current, 'zoho', '2026-06-14T00:00:00Z');

    // 2 signatures + 1 affected-services summary
    expect(ev).toHaveLength(3);
    const first = ev[0]!;
    expect(first.source).toBe('logs');
    expect(first.kind).toBe('log');
    expect(first.title).toContain('HTTPFLT001');
    expect(first.title).toContain('NEW');
    expect(first.relevance).toBe(0.95);
    expect(first.provenance.query).toBe('zoho');
    expect(ev[2]!.title).toContain('Affected service');
  });

  it('produces no evidence for an empty analysis', () => {
    const empty: LogAnalysis = {
      window: {},
      totalErrors: 0,
      signatures: [],
      newSignatures: [],
      affectedServices: [],
    };
    expect(analysisToEvidence(empty, 'q', 't')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseErrorAnalysis — dotted message fields (custom mapping + ECS)
// ---------------------------------------------------------------------------

describe('parseErrorAnalysis — dotted messageField', () => {
  // _source has nested `log: { message: '...' }` (ECS style).
  const nestedMessageFixture = {
    hits: { total: { value: 3 } },
    aggregations: {
      by_sig: {
        buckets: [
          {
            key: 'ERR001',
            doc_count: 3,
            first_seen: { value_as_string: '2026-06-13T10:00:00Z' },
            last_seen: { value_as_string: '2026-06-13T11:00:00Z' },
            services: { buckets: [{ key: 'api' }] },
            sample: {
              hits: {
                hits: [
                  {
                    _source: {
                      log: { message: 'nested msg text' },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      affected_services: { buckets: [] },
    },
  };

  it('reads a nested dotted messageField via getField', () => {
    const analysis = parseErrorAnalysis(
      nestedMessageFixture,
      {},
      'log.message',
    );
    expect(analysis.signatures[0]?.sampleMessage).toBe('nested msg text');
  });

  it('falls back to top-level message when dotted field is absent', () => {
    const fixture = {
      hits: { total: { value: 1 } },
      aggregations: {
        by_sig: {
          buckets: [
            {
              key: 'ERR002',
              doc_count: 1,
              first_seen: { value_as_string: '' },
              last_seen: { value_as_string: '' },
              services: { buckets: [] },
              sample: {
                hits: {
                  hits: [
                    { _source: { message: 'top-level fallback' } },
                  ],
                },
              },
            },
          ],
        },
        affected_services: { buckets: [] },
      },
    };
    const analysis = parseErrorAnalysis(fixture, {}, 'log.message');
    expect(analysis.signatures[0]?.sampleMessage).toBe('top-level fallback');
  });
});

describe('uncoded-error reconciliation (count vs signatures split)', () => {
  it('requests a `missing` bucket so uncoded error docs are not dropped', () => {
    const body = buildErrorAnalysisBody({ from: 'x' }, 'event_code', MERITT_FIELD_MAPPING);
    const bySig = (body['aggs'] as Record<string, unknown>)['by_sig'] as Record<string, unknown>;
    expect((bySig['terms'] as Record<string, unknown>)['missing']).toBe('(no code)');
  });

  it('surfaces uncoded errors as a "(no code)" signature so totalErrors reconciles', () => {
    // The reported failure window: 48 error docs, none carrying an event_code. ES
    // routes them into the `missing` bucket instead of dropping them, so the
    // signature path no longer returns [] while the count says 48.
    const resp = {
      hits: { total: { value: 48 } },
      aggregations: {
        by_sig: {
          buckets: [
            {
              key: '(no code)',
              doc_count: 48,
              first_seen: { value_as_string: '2026-07-18T10:00:00.000Z' },
              last_seen: { value_as_string: '2026-07-18T10:14:00.000Z' },
              services: { buckets: [{ key: 'leadcall-api-prod' }] },
              sample: {
                hits: {
                  hits: [{ _source: { message: 'Uncaught TypeError: cannot read x of undefined' } }],
                },
              },
            },
          ],
        },
        affected_services: { buckets: [{ key: 'leadcall-api-prod' }] },
      },
    };
    const a = parseErrorAnalysis(resp, { from: 'x', to: 'y' });
    expect(a.totalErrors).toBe(48);
    expect(a.signatures).toHaveLength(1);
    expect(a.signatures[0]!.key).toBe('(no code)');
    expect(a.signatures[0]!.count).toBe(48);
    expect(a.signatures[0]!.sampleMessage).toContain('Uncaught TypeError');
    // No more "48 errors / 0 signatures": the shown signatures now account for the count.
    const shown = a.signatures.reduce((sum, s) => sum + s.count, 0);
    expect(shown).toBe(a.totalErrors);
  });
})
