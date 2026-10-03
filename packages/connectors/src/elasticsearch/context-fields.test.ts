/**
 * HOR-215 / HOR-216 — structured context surfacing and broad text search.
 *
 * `horus logs --raw` must restore the structured context that makes a log line
 * debuggable (event_code, entity ids, the buried `detail`), and text queries must
 * be able to reach `detail` and `context.*`, not just the message field.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeHit,
  extractContextFields,
  buildTextMust,
  buildSearchBody,
  MERITT_FIELD_MAPPING,
} from './normalize.js';
import { buildErrorAggBody } from './normalize.js';

const FULFILLMENT_HIT = {
  _index: 'maison-safqa-prod-new-2026.06',
  _source: {
    time: '2026-06-17T20:58:55.992Z',
    level: 50,
    service_name: 'maison-safqa-prod-scheduler',
    component: 'OrderService',
    message: 'Error during fulfillment sync.',
    event_code: 'E_FULFILLMENT_SYNC_ERROR_04',
    context: {
      brand_id: '666f6c2e3a07d9d5f4e9f84b',
      brand_order_id: '5275487142020',
      error: 'Access denied for order field. Required access: `read_orders`',
    },
    detail: 'getaddrinfo ENOTFOUND monnier.strapi.gaiasuite.com',
  },
};

describe('normalizeHit — context + detail (HOR-215/216)', () => {
  it('extracts the structured context object', () => {
    const r = normalizeHit(FULFILLMENT_HIT, MERITT_FIELD_MAPPING);
    expect(r.context).toBeDefined();
    expect(r.context!['brand_id']).toBe('666f6c2e3a07d9d5f4e9f84b');
    expect(r.eventCode).toBe('E_FULFILLMENT_SYNC_ERROR_04');
  });

  it('extracts the detail field', () => {
    const r = normalizeHit(FULFILLMENT_HIT, MERITT_FIELD_MAPPING);
    expect(r.detail).toBe('getaddrinfo ENOTFOUND monnier.strapi.gaiasuite.com');
  });

  it('parses a JSON-string context blob', () => {
    const r = normalizeHit(
      { _index: 'i', _source: { time: 't', level: 50, message: 'm', context: '{"brand_id":"abc"}' } },
      MERITT_FIELD_MAPPING,
    );
    expect(r.context!['brand_id']).toBe('abc');
  });
});

describe('extractContextFields (HOR-215)', () => {
  it('returns code first, then context scalars, then detail', () => {
    const r = normalizeHit(FULFILLMENT_HIT, MERITT_FIELD_MAPPING);
    const fields = extractContextFields(r);
    const keys = fields.map((f) => f.key);
    expect(keys[0]).toBe('code');
    expect(keys).toContain('brand_id');
    expect(keys).toContain('brand_order_id');
    expect(keys).toContain('detail');
  });

  it('skips empty values and respects the limit', () => {
    const r = normalizeHit(
      { _index: 'i', _source: { time: 't', level: 50, message: 'm', context: { a: 1, b: '', c: 'x' } } },
      MERITT_FIELD_MAPPING,
    );
    const fields = extractContextFields(r, 2);
    expect(fields.length).toBeLessThanOrEqual(2);
    expect(fields.find((f) => f.key === 'b')).toBeUndefined();
  });
});

describe('buildTextMust — broad search (HOR-216)', () => {
  it('matches message only by default', () => {
    const must = buildTextMust({ text: 'boom' }, MERITT_FIELD_MAPPING);
    expect(must[0]).toEqual({ match: { message: 'boom' } });
  });

  it('matches across message, native event code, detail, and context.* when broadText is set', () => {
    const must = buildTextMust({ text: 'ENOTFOUND', broadText: true }, MERITT_FIELD_MAPPING);
    const mm = (must[0] as Record<string, any>)['multi_match'];
    expect(mm.query).toBe('ENOTFOUND');
    expect(mm.fields).toContain('message');
    expect(mm.fields).toContain('detail');
    expect(mm.fields).toContain('context.*');
    expect(mm.fields).toContain('event_code');
  });

  it('flows broadText through buildSearchBody', () => {
    const body = buildSearchBody({ text: 'x', broadText: true }, MERITT_FIELD_MAPPING);
    const must = ((body['query'] as any).bool.must)[0];
    expect(must.multi_match).toBeDefined();
  });
});

describe('buildErrorAggBody — eventCode scoping (HOR-215)', () => {
  it('adds a term filter on the signature field when eventCode is set', () => {
    const body = buildErrorAggBody(
      { from: '2026-06-10T00:00:00Z', eventCode: 'E_FULFILLMENT_SYNC_ERROR_04' },
      'context.brand_id',
      MERITT_FIELD_MAPPING,
    );
    const filters = (body['query'] as any).bool.filter as any[];
    const term = filters.find((f) => f.term && f.term['event_code.keyword']);
    expect(term).toBeDefined();
    expect(term.term['event_code.keyword']).toBe('E_FULFILLMENT_SYNC_ERROR_04');
    // aggregates the custom keyword field
    expect((body['aggs'] as any).by_key.terms.field).toBe('context.brand_id.keyword');
  });
});
