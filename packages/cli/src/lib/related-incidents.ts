import { resolveEnvironment, type HorusConfig } from '@horus/core';
import { openDb, listInvestigationsWithReports } from '@horus/db';
import {
  incidentsTouchingChanges,
  type ChangeImpactReport,
  type RelatedIncident,
} from '@horus/engine';

/**
 * Past incidents whose code a change touches, read from this project's saved investigations.
 * Best-effort: any config or store failure returns [] so change reports never fail on it.
 */
export async function relatedIncidentsFor(
  config: HorusConfig,
  report: Pick<ChangeImpactReport, 'modified' | 'removed'>,
  project?: string,
): Promise<RelatedIncident[]> {
  if (!report.modified.length && !report.removed.length) return [];
  try {
    const scope = project ?? resolveEnvironment(config).project;
    const { db, sql } = await openDb();
    try {
      return incidentsTouchingChanges(
        report,
        await listInvestigationsWithReports(db, 500, { project: scope }),
      );
    } finally {
      await sql.end();
    }
  } catch {
    return [];
  }
}
