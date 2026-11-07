import type { Logger } from 'pino';

import {
  buildAuditTrailQueries,
  PostgresAuditSearchRecorder,
  PostgresAuditTrail,
  PostgresAuditTrailReader,
  type AuditTrailQueries,
} from '@multitenant-base/audit';
import {
  buildMemberAdministration,
  buildRoleAdministration,
  PostgresPermissionCatalogue,
  PostgresRoleRepository,
  type MemberAdministration,
  type RoleAdministration,
} from '@multitenant-base/iam';
import {
  buildApiKeyAdministration,
  PostgresApiKeyRepository,
  RandomSecretGenerator,
  Sha256SecretHasher,
  type ApiKeyAdministration,
} from '@multitenant-base/integrations';
import type { Actor } from '@multitenant-base/shared-kernel';
import { permissionsFrom, type PolicyEnforcementPoint } from '@multitenant-base/shared-kernel';
import type { ResolvedTenant } from '@multitenant-base/tenancy';
import {
  buildPlanAdministration,
  buildQuotaUsageQueries,
  buildQueueMonitoring,
  buildSupportAccessAdministration,
  buildTenantProvisioning,
  PostgresPlanCatalogue,
  PostgresQuotaTenantDirectory,
  PostgresQuotaUsageStore,
  PostgresSupportAccessDirectory,
  PostgresTenantRegistry,
  verifyTenantQuota,
  type PlanAdministration,
  type QueueMonitoring,
  type QuotaUsageQueries,
  type QuotaVerificationOutcome,
  type SupportAccessAdministration,
  type TenantProvisioning,
  type TransactionRunner,
} from '@multitenant-base/tenancy';

import type { AppConfig } from '../config/environment.js';
import type { PlatformPrincipal, Principal } from '../http/plugins/authentication.js';
import type { ControlDatabase } from '../infrastructure/controlDatabase.js';
import { PostgresMemberDirectory } from '../infrastructure/memberDirectory.js';
import type { PgBossQueue } from '../infrastructure/queue/pgBossQueue.js';
import { PgBossQueueInspector } from '../infrastructure/queue/queueInspector.js';
import type { SharedSchemaConnectionProvider } from '../infrastructure/tenantConnection.js';
import {
  InvitingAdministratorProvisioner,
  LocalStorageProvisioner,
  MigratingSchemaProvisioner,
} from '../infrastructure/tenantProvisioning.js';
import { TenantQuotaCounter } from '../infrastructure/tenantQuotaCounter.js';

/**
 * Wiring for the platform's own capabilities: companies (tenants), their users and roles,
 * API keys, plans and quotas, queues, the audit trail and support access.
 *
 * Tenant-scoped adapters are assembled per request rather than once at boot, because they
 * are bound to one company: a singleton would have to be told which tenant on every call,
 * and "has to be told" is how it eventually is not.
 *
 * A project built on this base adds its own bounded contexts next to these, following the
 * same shape: a `with<Context>` function that binds a tenant connection and an actor, and
 * hands the route a use case built from ports.
 */

/**
 * The actor a platform request acts as.
 *
 * No tenant, and no placeholder. Staff belong to no company, and the audit trail records a
 * platform action with a null tenant — which its check constraint allows precisely for
 * this case. The first version of this passed the string `'platform'`, and it reached a
 * `uuid` column within the hour.
 */
function platformActor(staff: PlatformPrincipal): Actor {
  return {
    actorId: staff.authUserId,
    actorType: 'platform_admin',
    tenantId: undefined,
    roleCode: staff.roleCode,
    permissions: permissionsFrom(staff.permissions),
  };
}

export interface PlatformContextOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly controlDatabase: ControlDatabase;
  readonly connections: SharedSchemaConnectionProvider;
  readonly queue: PgBossQueue;
  readonly policyEnforcement: PolicyEnforcementPoint;
  readonly ids: { next(): string };
  /** Runs work on one control-plane connection inside a transaction. */
  readonly controlTransactions: TransactionRunner;
}

/** The actor a tenant member's request acts as, derived from the verified principal. */
function memberActor(principal: Principal): Actor {
  return {
    actorId: principal.authUserId,
    actorType: 'user',
    tenantId: principal.tenantId,
    roleCode: principal.roleCode,
    permissions: permissionsFrom(principal.permissions),
  };
}

export function buildPlatformContext(options: PlatformContextOptions) {
  async function loadTenant(tenantId: string): Promise<ResolvedTenant> {
    const rows = await options.controlDatabase.query<{
      id: string;
      name: string;
      schema_name: string;
      subdomain: string;
      isolation_mode: ResolvedTenant['isolationMode'];
      lifecycle_status: ResolvedTenant['lifecycleStatus'];
      timezone: string;
    }>(
      `select id, name, schema_name, subdomain, isolation_mode, lifecycle_status, timezone
         from control.tenants
        where id = $1`,
      [tenantId],
    );

    const row = rows[0];
    if (row === undefined) throw new Error(`No tenant ${tenantId}`);
    return {
      id: row.id,
      name: row.name,
      schemaName: row.schema_name,
      subdomain: row.subdomain,
      isolationMode: row.isolation_mode,
      lifecycleStatus: row.lifecycle_status,
      timezone: row.timezone,
    };
  }

  return {
    /**
     * API keys for one tenant (§10.1, VC-79).
     *
     * On the control connection: keys live in the control plane because the API
     * authenticates a request *before* any tenant is bound — the key is what decides which
     * tenant it is.
     */
    withApiKeys: async <T>(
      principal: Principal,
      work: (context: { actor: Actor; keys: ApiKeyAdministration }) => Promise<T>,
    ): Promise<T> => {
      return work({
        actor: memberActor(principal),
        keys: buildApiKeyAdministration({
          pep: options.policyEnforcement,
          keys: new PostgresApiKeyRepository({
            query: (sql, values) => options.controlDatabase.query(sql, values),
          }),
          hasher: new Sha256SecretHasher(),
          secrets: new RandomSecretGenerator(),
          ids: options.ids,
          clock: { now: () => new Date() },
          tenantOf: () => principal.tenantId,
          audit: async (input) => {
            await options.controlDatabase.query(
              `insert into control.audit_events
                      (event_id, tenant_id, actor_type, actor_id, action,
                       resource_type, resource_id, result, occurred_at, changes)
               values (gen_random_uuid(), $1, 'user', $2, $3, 'api_key', $4, 'success',
                       now(), $5::jsonb)`,
              [
                principal.tenantId,
                input.actorId,
                input.action,
                input.keyId,
                // The prefix, never the secret: a trail that records a credential is a
                // second copy of it (§8.4).
                JSON.stringify(input.changes),
              ],
            );
          },
        }),
      });
    },

    /**
     * Role administration, bound to one tenant.
     *
     * Runs on the *control* connection, not a tenant one: roles live in the control plane
     * because a tenant's own role and a shared system role sit in the same table, and the
     * tenant scoping is the `tenant_id` the repository is constructed with.
     */
    withRoles: async <T>(
      principal: Principal,
      work: (context: {
        actor: Actor;
        roles: RoleAdministration;
        members: MemberAdministration;
      }) => Promise<T>,
    ): Promise<T> => {
      const directory = new PostgresMemberDirectory({
        controlDatabase: options.controlDatabase,
        // From the verified token, never the request: this is the boundary that stops one
        // company's administrator from enumerating another's staff (§8.3).
        tenantId: principal.tenantId,
        authUrl: options.config.auth.authUrl,
        serviceRoleKey:
          'serviceRoleKey' in options.config.auth ? options.config.auth.serviceRoleKey : undefined,
        logger: options.logger,
      });

      return work({
        actor: memberActor(principal),
        roles: buildRoleAdministration({
          pep: options.policyEnforcement,
          roles: new PostgresRoleRepository(options.controlDatabase),
          catalogue: new PostgresPermissionCatalogue(options.controlDatabase),
          ids: options.ids,
          audit: async (input) => {
            await options.controlDatabase.query(
              `insert into control.audit_events
                      (event_id, tenant_id, actor_type, actor_id, action,
                       resource_type, resource_id, result, occurred_at, changes)
               values (gen_random_uuid(), $1, 'user', $2, $3, 'role', $4, 'success',
                       now(), $5::jsonb)`,
              [
                principal.tenantId,
                input.actorId,
                input.action,
                input.roleId,
                JSON.stringify(input.changes),
              ],
            );
          },
        }),
        members: buildMemberAdministration({
          pep: options.policyEnforcement,
          members: directory,
          describeRole: async (roleCode) => {
            const rows = await options.controlDatabase.query<{
              can_manage_users: boolean;
              is_platform_role: boolean;
            }>(
              `select
                 exists (select 1 from control.role_permissions rp
                          where rp.role_id = r.id and rp.permission_code = 'iam:user_manage')
                   as can_manage_users,
                 -- Derived, not a list of names: a role carrying any platform capability
                 -- belongs to the platform, not to a client (§8.1).
                 exists (select 1 from control.role_permissions rp
                          where rp.role_id = r.id and rp.permission_code like 'platform:%')
                   as is_platform_role
                 from control.roles r
                where r.code = $1 and (r.tenant_id is null or r.tenant_id = $2)`,
              [roleCode, principal.tenantId],
            );

            const row = rows[0];
            return row === undefined
              ? undefined
              : { canManageUsers: row.can_manage_users, isPlatformRole: row.is_platform_role };
          },
          audit: async (input) => {
            await options.controlDatabase.query(
              `insert into control.audit_events
                      (event_id, tenant_id, actor_type, actor_id, action,
                       resource_type, resource_id, result, occurred_at, changes)
               values (gen_random_uuid(), $1, 'user', $2, $3, 'tenant_member', $4, 'success',
                       now(), $5::jsonb)`,
              [
                principal.tenantId,
                input.actorId,
                input.action,
                input.memberId,
                JSON.stringify(input.changes),
              ],
            );
          },
        }),
      });
    },

    /**
     * The platform panel (§9).
     *
     * Takes a `PlatformPrincipal`, never a tenant one. Staff belong to no company, and no
     * tenant-scoped repository is constructed anywhere in this path.
     */
    withPlatform: async <T>(
      staff: PlatformPrincipal,
      work: (context: { actor: Actor; provisioning: TenantProvisioning }) => Promise<T>,
    ): Promise<T> => {
      return work({
        actor: {
          actorId: staff.authUserId,
          actorType: 'platform_admin',
          // No tenant, and no placeholder. Staff belong to no company, and the audit trail
          // records a platform action with a null tenant — which its check constraint
          // allows precisely for this case.
          tenantId: undefined,
          roleCode: staff.roleCode,
          permissions: permissionsFrom(staff.permissions),
        },
        provisioning: buildTenantProvisioning({
          pep: options.policyEnforcement,
          tenants: new PostgresTenantRegistry({
            client: options.controlDatabase,
            transactions: options.controlTransactions,
            // The trail is written on the same connection as the change, so a suspension
            // that rolls back leaves no record of having happened (§8.4).
            audit: {
              record: async (client, event) => {
                await new PostgresAuditTrail(client).record({
                  occurredAt: event.occurredAt,
                  tenantId: event.tenantId,
                  actorType: 'platform_admin',
                  actorId: event.actorId,
                  action: event.action,
                  resourceType: 'tenant',
                  resourceId: event.tenantId,
                  result: 'success',
                  ...(event.changes === undefined ? {} : { changes: event.changes }),
                });
              },
            },
            clock: { now: () => new Date() },
          }),
          schemas: new MigratingSchemaProvisioner({
            pool: options.controlDatabase.pool,
            migrationsDirectory: options.config.tenantMigrationsDirectory,
            logger: options.logger,
          }),
          storage: new LocalStorageProvisioner(options.config.storage.rootDirectory),
          administrators: new InvitingAdministratorProvisioner({
            pool: options.controlDatabase.pool,
            authUrl: options.config.auth.authUrl,
            serviceRoleKey:
              'serviceRoleKey' in options.config.auth
                ? options.config.auth.serviceRoleKey
                : undefined,
            logger: options.logger,
          }),
          ids: options.ids,
          clock: { now: () => new Date() },
        }),
      });
    },

    /**
     * Plans, quotas and usage (§4.2, §9).
     *
     * `PlatformPrincipal` again, never a tenant one: repricing a plan and reading who is
     * against a limit are both platform acts, and no adapter constructed here is bound to
     * a tenant's schema.
     */
    withPlans: async <T>(
      staff: PlatformPrincipal,
      work: (context: {
        actor: Actor;
        plans: PlanAdministration;
        quotas: QuotaUsageQueries;
      }) => Promise<T>,
    ): Promise<T> => {
      const catalogue = new PostgresPlanCatalogue({
        client: options.controlDatabase,
        transactions: options.controlTransactions,
        // The trail is written on the same connection as the change, so a repricing that
        // rolls back leaves no record of having happened (§8.4).
        audit: {
          record: async (client, event) => {
            await new PostgresAuditTrail(client).record({
              occurredAt: event.occurredAt,
              ...(event.tenantId === undefined ? {} : { tenantId: event.tenantId }),
              actorType: 'platform_admin',
              actorId: event.actorId,
              action: event.action,
              resourceType: event.resourceType,
              resourceId: event.resourceId,
              result: 'success',
              changes: event.changes,
            });
          },
        },
        clock: { now: () => new Date() },
      });

      return work({
        actor: platformActor(staff),
        plans: buildPlanAdministration({ pep: options.policyEnforcement, plans: catalogue }),
        quotas: buildQuotaUsageQueries({
          pep: options.policyEnforcement,
          tenants: new PostgresQuotaTenantDirectory(options.controlDatabase),
          store: new PostgresQuotaUsageStore(options.controlDatabase),
        }),
      });
    },

    /**
     * Entering and leaving a client's account (§8.1, VC-101).
     *
     * Takes the staff identity as fields rather than a `PlatformPrincipal`, because the
     * exit route runs while the request no longer carries one: for as long as a grant is
     * live the request *is* the client's user, and the only thing left of the staff member
     * is the id inside the grant. Handing that id in is what lets the door open from the
     * inside without also handing back the powers they stepped out of.
     */
    withSupportAccess: async <T>(
      staffAuthUserId: string,
      roleCode: string,
      permissions: readonly string[],
      work: (context: { actor: Actor; supportAccess: SupportAccessAdministration }) => Promise<T>,
    ): Promise<T> => {
      return work({
        actor: {
          actorId: staffAuthUserId,
          // The human is staff whichever door they came through, and the trail says so.
          actorType: 'platform_admin',
          tenantId: undefined,
          roleCode,
          permissions: permissionsFrom(permissions),
        },
        supportAccess: buildSupportAccessAdministration({
          pep: options.policyEnforcement,
          directory: new PostgresSupportAccessDirectory({ client: options.controlDatabase }),
          audit: {
            record: async (input) => {
              await options.controlDatabase.query(
                `insert into control.audit_events
                        (event_id, tenant_id, actor_type, actor_id, action,
                         resource_type, resource_id, result, occurred_at, changes)
                 values (gen_random_uuid(), $1, 'platform_admin', $2, $3, 'tenant_member', $4,
                         'success', now(), $5::jsonb)`,
                [
                  // Filed under the client, so the company's own audit view shows that we
                  // were inside their account and for how long.
                  input.tenantId,
                  input.actorId,
                  input.action,
                  input.memberId,
                  JSON.stringify(input.changes),
                ],
              );
            },
          },
        }),
      });
    },

    /** Queue and dead-letter monitoring (§7, §9, §14). */
    withQueues: async <T>(
      staff: PlatformPrincipal,
      work: (context: { actor: Actor; queues: QueueMonitoring }) => Promise<T>,
    ): Promise<T> => {
      return work({
        actor: platformActor(staff),
        queues: buildQueueMonitoring({
          pep: options.policyEnforcement,
          queues: new PgBossQueueInspector({
            pool: options.controlDatabase.pool,
            queue: options.queue,
          }),
          audit: {
            record: async (input) => {
              await options.controlDatabase.query(
                `insert into control.audit_events
                        (event_id, tenant_id, actor_type, actor_id, action,
                         resource_type, resource_id, result, occurred_at, changes)
                 values (gen_random_uuid(), $1, 'platform_admin', $2, $3, 'job', $4,
                         'success', now(), $5::jsonb)`,
                [
                  // A job replayed for a client is filed under that client, so the
                  // company's own audit view shows that we touched their queue.
                  input.tenantId ?? null,
                  input.actorId,
                  input.action,
                  input.jobId,
                  JSON.stringify(input.changes),
                ],
              );
            },
          },
        }),
      });
    },

    /** The cross-tenant audit query, itself audited (§8.4, §9). */
    withAuditTrail: async <T>(
      staff: PlatformPrincipal,
      work: (context: { actor: Actor; audit: AuditTrailQueries }) => Promise<T>,
    ): Promise<T> => {
      return work({
        actor: platformActor(staff),
        audit: buildAuditTrailQueries({
          pep: options.policyEnforcement,
          reader: new PostgresAuditTrailReader(options.controlDatabase),
          recorder: new PostgresAuditSearchRecorder(options.controlDatabase),
          clock: { now: () => new Date() },
        }),
      });
    },

    /**
     * One tenant's daily quota verification (RN-26..RN-29, VC-28, VC-42).
     *
     * Driven by the `plan-quota-verification` scheduled job, not by a request, so there is
     * no actor and no policy check: the principal is the process itself. What protects the
     * client here is that the counter can return nothing but three integers.
     */
    verifyQuota: async (tenantId: string): Promise<QuotaVerificationOutcome | undefined> => {
      const directory = new PostgresQuotaTenantDirectory(options.controlDatabase);
      const tenant = (await directory.listMeasurable()).find(
        (candidate) => candidate.id === tenantId,
      );
      // A client suspended or half-provisioned since the job was enqueued. Skipped rather
      // than failed: there is nothing wrong, and a dead-lettered job would say there was.
      if (tenant === undefined) return undefined;

      return verifyTenantQuota({
        counter: new TenantQuotaCounter({ controlDatabase: options.controlDatabase }),
        store: new PostgresQuotaUsageStore(options.controlDatabase),
        alerts: {
          publish: async (target, event) => {
            const resolved = await loadTenant(target.id);
            // Into the tenant's outbox, in its own transaction, so the poller delivers it
            // exactly like every other domain event (§6). Publishing straight to the queue
            // would put an alert on the wire for a measurement that had not committed.
            await options.connections.withTenant(resolved, async (client) => {
              await client.query(
                `insert into outbox_events (event_id, tenant_id, type, occurred_at, payload,
                                            correlation_id, causation_id)
                      values ($1, $2, $3, $4, $5::jsonb, $6, null)
                 on conflict (event_id) do nothing`,
                [
                  event.eventId,
                  event.tenantId,
                  event.type,
                  event.occurredAt,
                  JSON.stringify(event.payload),
                  event.correlationId,
                ],
              );
            });
          },
        },
        clock: { now: () => new Date() },
        ids: options.ids,
      })(tenant);
    },
  };
}
