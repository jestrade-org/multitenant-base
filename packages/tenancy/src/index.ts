/**
 * Tenancy & Platform — client onboarding, plans, lifecycle and schema provisioning.
 *
 * This file is the context's entire public API. Other contexts reach this one only
 * through the symbols listed here — never by importing its `domain/` directly and
 * never by reading its tables. Cross-context communication goes through this surface
 * or through a domain event.
 */

export {
  loadTenantMigrations,
  migrateAllTenants,
  quoteIdentifier,
  quoteLiteral,
  type MigrateTenantsOptions,
  type SqlClient,
  type TenantMigrationOutcome,
  type TenantMigrationResult,
  type TenantToMigrate,
} from './infrastructure/migrations/runner.js';

export {
  acceptResolvedTenant,
  selectTenantLookup,
  subdomainFromHost,
  type ResolvedTenant,
  type TenantHints,
  type TenantHintSource,
  type TenantLookup,
  type TenantRejection,
  type TenantResolution,
  type TenantSelection,
} from './application/tenantResolution.js';

export { TenantDirectory, type TenantDirectoryOptions } from './infrastructure/tenantDirectory.js';

export {
  planMigrations,
  type AppliedMigration,
  type AvailableMigration,
  type MigrationPlan,
} from './infrastructure/migrations/plan.js';

export {
  normalizeTaxId,
  prepareTenantRegistration,
  suggestSubdomain,
  TenantAlreadyRegisteredError,
  type RegisterTenantInput,
  type TenantRegistration,
} from './domain/tenantRegistration.js';

export {
  buildTenantProvisioning,
  type FirstAdministratorProvisioner,
  type LifecycleAudit,
  type ProvisionTenantCommand,
  type ProvisionTenantDependencies,
  type ProvisionTenantResult,
  type SchemaProvisioner,
  type TenantProvisioning,
  type TenantRegistry,
  type TenantStorageProvisioner,
  type TenantSummaryDto,
  TenantNotFoundError,
} from './application/provisionTenant.js';

export {
  PostgresTenantRegistry,
  type PostgresTenantRegistryOptions,
  type TenantAuditSink,
  type TransactionRunner,
} from './infrastructure/postgresTenantRegistry.js';

export {
  assertWithinQuota,
  definePlan,
  limitFor,
  PlanCodeAlreadyExistsError,
  PlanNotFoundError,
  PlanQuotaExceededError,
  QUOTA_KINDS,
  QUOTA_WARNING_RATIO,
  readAllQuotas,
  readQuota,
  validateQuotas,
  worstStatus,
  type MeasuredUsage,
  type Plan,
  type PlanQuotas,
  type QuotaKind,
  type QuotaReading,
  type QuotaStatus,
} from './domain/planQuota.js';

export {
  buildPlanAdministration,
  type AssignPlanCommand,
  type DefinePlanCommand,
  type PlanAdministration,
  type PlanAdministrationDependencies,
  type PlanAssignmentAudit,
  type PlanAudit,
  type PlanCatalogue,
  type PlanDto,
} from './application/managePlans.js';

export {
  buildQuotaUsageQueries,
  verifyTenantQuota,
  type QuotaAlertPublisher,
  type QuotaTenantDirectory,
  type QuotaUsageQueries,
  type QuotaUsageSnapshot,
  type QuotaUsageStore,
  type QuotaVerificationDependencies,
  type QuotaVerificationOutcome,
  type TenantQuotaUsageDto,
  type TenantToMeasure,
  type TenantUsageCounter,
} from './application/quotaUsage.js';

export {
  buildQueueMonitoring,
  type DeadLetterJobDto,
  type JobActionCommand,
  type ListDeadLetteredCommand,
  type QueueAudit,
  type QueueInspector,
  type QueueMonitoring,
  type QueueMonitoringDependencies,
  type QueueSnapshotDto,
} from './application/monitorQueues.js';

export {
  PostgresPlanCatalogue,
  type PlatformAuditSink,
  type PostgresPlanCatalogueOptions,
} from './infrastructure/postgresPlanCatalogue.js';

export {
  PostgresQuotaTenantDirectory,
  PostgresQuotaUsageStore,
} from './infrastructure/postgresQuotaUsage.js';

export {
  buildSupportAccessAdministration,
  MemberNotReachableError,
  type BeginSupportAccessCommand,
  type EndedGrantDto,
  type SearchMembersCommand,
  type SupportAccessAdministration,
  type SupportAccessAudit,
  type SupportAccessDependencies,
  type SupportAccessDirectory,
  type SupportAccessGrantDto,
  type TenantMemberDto,
} from './application/manageSupportAccess.js';

export {
  PostgresSupportAccessDirectory,
  type PostgresSupportAccessOptions,
} from './infrastructure/postgresSupportAccess.js';
