/**
 * Audit and compliance — the immutable record of who did what (§8.4).
 *
 * This file is the package's entire public API; each symbol is listed explicitly.
 */
export {
  implementedAuditActions,
  pendingAuditActions,
  REQUIRED_AUDIT_ACTIONS,
  type RequiredAuditAction,
} from './domain/requiredAuditActions.js';

export {
  assertRecordableAuditEvent,
  type AuditActorType,
  type AuditChanges,
  type AuditEvent,
  type AuditResult,
} from './domain/auditEvent.js';

export {
  AuthorizationAuditTrail,
  PostgresAuditTrail,
  type AuditRequestContext,
  type SqlClient,
} from './infrastructure/postgresAuditTrail.js';

export {
  assertActionFilter,
  AuditWindowTooWideError,
  boundedWindow,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  type AuditWindow,
  type AuditWindowInput,
} from './domain/auditQuery.js';

export {
  buildAuditTrailQueries,
  type AuditEventDto,
  type AuditPage,
  type AuditSearchCriteria,
  type AuditSearchRecorder,
  type AuditTrailQueries,
  type AuditTrailQueryDependencies,
  type AuditTrailReader,
  type ResolvedAuditSearch,
} from './application/queryAuditTrail.js';

export {
  PostgresAuditSearchRecorder,
  PostgresAuditTrailReader,
} from './infrastructure/postgresAuditTrailReader.js';
