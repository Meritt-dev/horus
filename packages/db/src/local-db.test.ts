import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, shouldUseEmbeddedDb, isDbUnavailable, DB_UNAVAILABLE_PREFIX } from './client.js';
import { listInvestigations, listInvestigationsWithReports, getLastInvestigationId } from './investigations.js';
import { investigations, incidentMemory, memoryItem, memoryLink, memoryAudit } from './schema.js';
import { eq } from 'drizzle-orm';

const DEFAULT = 'postgresql://horus:horus@localhost:5433/horus';

describe('shouldUseEmbeddedDb (driver selection)', () => {
  const saved = process.env['DATABASE_URL'];
  beforeEach(() => {
    delete process.env['DATABASE_URL'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = saved;
  });

  it('uses embedded for empty/unset url', () => {
    expect(shouldUseEmbeddedDb(undefined)).toBe(true);
    expect(shouldUseEmbeddedDb('')).toBe(true);
    expect(shouldUseEmbeddedDb('   ')).toBe(true);
  });

  it('uses embedded for the local-default placeholder when DATABASE_URL is unset', () => {
    expect(shouldUseEmbeddedDb(DEFAULT)).toBe(true);
  });

  it('uses postgres-js when DATABASE_URL is explicitly set', () => {
    process.env['DATABASE_URL'] = DEFAULT;
    expect(shouldUseEmbeddedDb(DEFAULT)).toBe(false);
  });

  it('uses postgres-js for a non-default configured url', () => {
    expect(shouldUseEmbeddedDb('postgresql://u:p@db.example.com:5432/app')).toBe(false);
  });
});

describe('isDbUnavailable (display-only fallback detection)', () => {
  it('matches errors thrown by the unavailable-db fallback', () => {
    // The exact message the Proxy in unavailableDbHandle throws on any property access.
    const err = new Error(
      `${DB_UNAVAILABLE_PREFIX}: the embedded local database is not available in this build.`,
    );
    expect(isDbUnavailable(err)).toBe(true);
  });

  it('matches the asset-missing pre-check error too', () => {
    const err = new Error(`${DB_UNAVAILABLE_PREFIX}: embedded database asset missing (pglite.wasm).`);
    expect(isDbUnavailable(err)).toBe(true);
  });

  it('does not match unrelated errors or non-Error values', () => {
    expect(isDbUnavailable(new Error('connection refused'))).toBe(false);
    expect(isDbUnavailable(new Error('the db was HORUS_DB_UNAVAILABLE'))).toBe(false); // prefix only
    expect(isDbUnavailable('HORUS_DB_UNAVAILABLE: string, not Error')).toBe(false);
    expect(isDbUnavailable(undefined)).toBe(false);
    expect(isDbUnavailable(null)).toBe(false);
  });
});

describe('createLocalDb (embedded pglite)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'horus-db-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies migrations and round-trips investigations + incident_memory', async () => {
    const { db, sql } = await createLocalDb({ path: join(dir, 'horus.db') });
    try {
      const ins = await db
        .insert(investigations)
        .values({
          title: 'Test incident',
          incidentInput: { hint: 'queue backlog', repo: 'r', nested: { a: [1, 2] } },
          status: 'open',
          summary: 's',
          report: { confidence: 0.5 },
        })
        .returning({ id: investigations.id });
      const id = ins[0]!.id;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      await db.insert(incidentMemory).values({
        investigationId: id,
        project: 'r',
        title: 'queue backlog',
        tags: ['mod/area', 'queue-x'], // text[]
        payload: { confidence: 0.5 }, // jsonb
      });

      const back = await db.select().from(investigations).where(eq(investigations.id, id));
      expect(back[0]!.createdAt).toBeInstanceOf(Date);
      expect(back[0]!.incidentInput).toEqual({ hint: 'queue backlog', repo: 'r', nested: { a: [1, 2] } });

      const mem = await db.select().from(incidentMemory).where(eq(incidentMemory.project, 'r'));
      expect(mem[0]!.tags).toEqual(['mod/area', 'queue-x']);
    } finally {
      await sql.end();
    }
  }, 30_000);

  it('0007: applies the memory_item/_link/_audit tables from the embedded bundle and round-trips them', async () => {
    // Bundle parity: single-file CLI installs rely on EMBEDDED_MIGRATIONS, not the drizzle/ dir.
    const { db, sql } = await createLocalDb({ path: join(dir, 'horus.db') });
    try {
      await db.insert(memoryItem).values({
        id: 'mem_01',
        kind: 'decision',
        claim: 'queue consumers must ack before processing',
        scope: 'repo',
        source: 'human',
        confidence: 0.8,
        repo: 'r',
      });

      await db.insert(memoryLink).values({
        id: 'lnk_01',
        fromMemoryId: 'mem_01',
        rel: 'about-symbol',
        toKind: 'node',
        toRef: 'Function:src/queue.ts:consume',
        toFilePath: 'src/queue.ts',
      });

      await db.insert(memoryAudit).values({
        id: 'aud_01',
        memoryId: 'mem_01',
        action: 'add',
        actor: { kind: 'user', id: 'u1' },
        toStatus: 'fresh',
        note: 'created',
      });

      const items = await db.select().from(memoryItem).where(eq(memoryItem.repo, 'r'));
      expect(items).toHaveLength(1);
      expect(items[0]!.status).toBe('fresh'); // default applied
      expect(items[0]!.visibility).toBe('private'); // default applied
      expect(items[0]!.evidence).toEqual([]); // jsonb default '[]'
      expect(items[0]!.createdAt).toBeInstanceOf(Date);

      const links = await db.select().from(memoryLink).where(eq(memoryLink.fromMemoryId, 'mem_01'));
      expect(links[0]!.rel).toBe('about-symbol');
      expect(links[0]!.toFilePath).toBe('src/queue.ts');

      const audit = await db.select().from(memoryAudit).where(eq(memoryAudit.memoryId, 'mem_01'));
      expect(audit[0]!.actor).toEqual({ kind: 'user', id: 'u1' });

      // ON DELETE cascade: removing the item clears its links + audit rows.
      await db.delete(memoryItem).where(eq(memoryItem.id, 'mem_01'));
      expect(await db.select().from(memoryLink)).toHaveLength(0);
      expect(await db.select().from(memoryAudit)).toHaveLength(0);
    } finally {
      await sql.end();
    }
  }, 30_000);

  it('is idempotent: re-opening an existing db does not re-run migrations or lose data', async () => {
    const path = join(dir, 'horus.db');
    const first = await createLocalDb({ path });
    await first.db.insert(investigations).values({
      title: 'persisted',
      incidentInput: {},
      summary: null,
    });
    await first.sql.end();

    const second = await createLocalDb({ path });
    try {
      const rows = await second.db.select().from(investigations);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe('persisted');
    } finally {
      await second.sql.end();
    }
  }, 30_000);

  it('N1 REGRESSION: investigation reads are project-scoped on the shared DB', async () => {
    // Dogfood N1: `horus investigations`/onboard/priors/cloud-sync in one repo listed
    // ANOTHER project's incident titles — the table had no project column and every
    // read was unscoped. Verify the migration + scoped reads end-to-end.
    const { db, sql } = await createLocalDb({ path: join(dir, 'horus.db') });
    try {
      await db.insert(investigations).values([
        { title: 'maison incident', incidentInput: { repo: 'maison-safqa' }, project: 'maison-safqa' },
        { title: 'leadcall incident', incidentInput: { repo: 'leadcall-api' }, project: 'leadcall-api' },
        { title: 'legacy row', incidentInput: {}, project: null },
      ]);

      const maison = await listInvestigations(db, 20, { project: 'maison-safqa' });
      expect(maison.map((r) => r.title)).toEqual(['maison incident']);

      // Unscoped (single-project setups / no resolvable project) still sees everything.
      const all = await listInvestigations(db, 20);
      expect(all).toHaveLength(3);

      // Reports + last-id follow the same scope.
      const reports = await listInvestigationsWithReports(db, 20, { project: 'leadcall-api' });
      expect(reports.map((r) => r.title)).toEqual(['leadcall incident']);
      const lastMaison = await getLastInvestigationId(db, { project: 'maison-safqa' });
      expect(lastMaison).toBe(maison[0]!.id);
    } finally {
      await sql.end();
    }
  }, 30_000);

  it('gap 7: holds a write-lock for the session and releases it on close', async () => {
    const path = join(dir, 'horus.db');
    const lockPath = `${path}.lock`;
    const h = await createLocalDb({ path });
    expect(existsSync(lockPath)).toBe(true); // lock held while the session is open
    await h.sql.end();
    expect(existsSync(lockPath)).toBe(false); // released on close, so the next run can acquire it
  }, 30_000);
});
