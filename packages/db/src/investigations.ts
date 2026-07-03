import { desc, eq } from 'drizzle-orm';

/**
 * Optional project scope for investigation reads. The shared local DB holds EVERY
 * project's investigations; unscoped reads leaked one project's incident titles into
 * another's `investigations`/onboard/priors/cloud-sync (dogfood N1). `project`
 * undefined = unscoped (single-project setups / id-addressed access).
 */
export interface InvestigationScope {
  project?: string;
}
import type { HorusDb } from './client.js';
import { investigations } from './schema.js';

/** Update the stored report JSON blob for an investigation (used to persist AI judgment). */
export async function updateInvestigationReport(
  db: HorusDb,
  id: string,
  report: unknown,
): Promise<void> {
  await db
    .update(investigations)
    .set({ report })
    .where(eq(investigations.id, id));
}

export async function getInvestigation(db: HorusDb, id: string) {
  const rows = await db
    .select()
    .from(investigations)
    .where(eq(investigations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Return the id of the most recently created investigation, or null when none exist.
 * Same ordering as {@link listInvestigations} (createdAt desc) so "the last investigation"
 * means the same row both surfaces would show first. Powers `horus feedback` with no id.
 */
export async function getLastInvestigationId(
  db: HorusDb,
  scope: InvestigationScope = {},
): Promise<string | null> {
  const rows = await db
    .select({ id: investigations.id })
    .from(investigations)
    .where(scope.project === undefined ? undefined : eq(investigations.project, scope.project))
    .orderBy(desc(investigations.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function listInvestigations(db: HorusDb, limit = 20, scope: InvestigationScope = {}) {
  return db
    .select({
      id: investigations.id,
      title: investigations.title,
      status: investigations.status,
      summary: investigations.summary,
      createdAt: investigations.createdAt,
    })
    .from(investigations)
    .where(scope.project === undefined ? undefined : eq(investigations.project, scope.project))
    .orderBy(desc(investigations.createdAt))
    .limit(limit);
}

export async function listInvestigationsWithReports(
  db: HorusDb,
  limit = 20,
  scope: InvestigationScope = {},
) {
  return db
    .select({
      id: investigations.id,
      title: investigations.title,
      createdAt: investigations.createdAt,
      report: investigations.report,
    })
    .from(investigations)
    .where(scope.project === undefined ? undefined : eq(investigations.project, scope.project))
    .orderBy(desc(investigations.createdAt))
    .limit(limit);
}
