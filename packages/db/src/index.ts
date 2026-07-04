export * as schema from './schema.js';
export {
  projects,
  repositories,
  investigations,
  evidence,
  findings,
  hypotheses,
  incidentMemory,
  memoryItem,
  memoryLink,
  memoryAudit,
  outcomeLabel,
  queueEdges,
  providerCache,
} from './schema.js';
export type {
  Project,
  NewProject,
  Repository,
  NewRepository,
  Investigation,
  Evidence,
  Finding,
  NewFinding,
  Hypothesis,
  IncidentMemory,
  NewIncidentMemory,
  MemoryItem,
  NewMemoryItem,
  MemoryLink,
  NewMemoryLink,
  MemoryAudit,
  NewMemoryAudit,
  OutcomeLabel,
  NewOutcomeLabel,
  QueueEdge,
  NewQueueEdge,
  ProviderCacheRow,
} from './schema.js';
export {
  createLocalDb,
  openDb,
  importFromPostgres,
  localDbPath,
  isDbUnavailable,
  DB_UNAVAILABLE_PREFIX,
  type HorusDb,
  type DbHandle,
} from './client.js';
export {
  assertLocalDatabaseUrl,
  looksLikeCloudDatabaseUrl,
  cloudDatabaseUrlReason,
  CloudDatabaseUrlError,
} from './guard.js';
export { eq, desc, sql, and, or } from 'drizzle-orm';
export { replaceQueueEdges, listQueueEdges } from './queue.js';
export {
  recordOutcomeLabel,
  listOutcomeLabels,
  getLatestOutcomeLabel,
  summarizeOutcomeLabels,
  dedupeToCurrentVerdict,
  isOutcomeResolved,
  isOutcomeSource,
  OUTCOME_RESOLVED,
  OUTCOME_SOURCE,
  type OutcomeResolved,
  type OutcomeSource,
  type OutcomeLabelInput,
  type OutcomeLabelQuery,
  type OutcomeAccuracy,
} from './outcome.js';
export {
  getInvestigation,
  getLastInvestigationId,
  listInvestigations,
  listInvestigationsWithReports,
  updateInvestigationReport,
  type InvestigationScope,
} from './investigations.js';
export { checkEmbeddedDb, EXPECTED_TABLES, type DbHealth } from './health.js';
