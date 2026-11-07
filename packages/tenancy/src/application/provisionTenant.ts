import {
  ApplicationError,
  authorizedUseCase,
  permission,
  requireAll,
  type Actor,
  type AuthorizedUseCase,
  type Clock,
  type IdGenerator,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

import {
  prepareTenantRegistration,
  TenantAlreadyRegisteredError,
  type RegisterTenantInput,
} from '../domain/tenantRegistration.js';

/**
 * Provisioning a client (§4, VC-27).
 *
 * Five steps, sequential and audited. The MVP deliberately has no orchestrator with
 * automatic retries and rollback — with fifteen clients that machinery costs more than it
 * saves (§19.1) — so the design instead makes every step **safe to run again**. An operator
 * whose browser dropped mid-way presses the button a second time and lands in the same
 * place, which is the property that actually matters at this scale.
 *
 * The uncomfortable part, stated plainly: **creating a schema is not transactional with
 * writing the row.** Postgres will not roll back a `create schema` when the surrounding
 * transaction aborts in every configuration, and the migrations that follow certainly will
 * not. So the order is chosen so that a failure at any point leaves something an operator
 * can understand and resume, never a client half-created that nobody can see:
 *
 *   1. the row, in a transaction, with `lifecycle_status = 'onboarding'` and no
 *      `provisioned_at` — a client that exists and is not ready yet;
 *   2. the schema and its migrations, idempotent by construction;
 *   3. the storage prefix;
 *   4. the first administrator;
 *   5. `provisioned_at` set and `TenantProvisioned` recorded — the only step that says
 *      "this client is ready", and the last one to run.
 *
 * A tenant with a row and no `provisioned_at` is therefore the visible state of "something
 * stopped", and re-running finishes it.
 */

const TENANT_MANAGE = permission('platform:tenant_manage');

export interface TenantSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly taxId: string;
  readonly subdomain: string;
  readonly schemaName: string;
  readonly timezone: string;
  readonly planCode: string;
  readonly lifecycleStatus: string;
  readonly isProvisioned: boolean;
  readonly createdAt: string;
}

/** No client with that id. Answered as 404 at the boundary. */
export class TenantNotFoundError extends ApplicationError {
  public override readonly name = 'TenantNotFoundError';
  public readonly code = 'TENANT_NOT_FOUND';

  public constructor(public readonly tenantId: string) {
    super(`No tenant ${tenantId}`, { tenantId });
  }
}

/**
 * Who changed a client's lifecycle, for the trail (§8.4).
 *
 * Part of the write's signature rather than a separate call, because §8.4 requires the
 * audit row to be written *with* the change: an implementation that cannot do both
 * atomically cannot satisfy this interface, and one that ignores the argument is a lie the
 * type system would otherwise permit.
 */
export interface LifecycleAudit {
  readonly actorId: string;
  readonly action: 'tenant.provisioned' | 'tenant.suspended' | 'tenant.resumed';
  readonly correlationId?: string;
}

export interface TenantRegistry {
  findByTaxId(taxId: string): Promise<TenantSummaryDto | undefined>;
  findBySubdomain(subdomain: string): Promise<TenantSummaryDto | undefined>;
  findById(tenantId: string): Promise<TenantSummaryDto | undefined>;
  list(): Promise<readonly TenantSummaryDto[]>;
  /** Writes the row. Idempotent on id, so a resumed provisioning does not duplicate it. */
  register(input: {
    readonly id: string;
    readonly name: string;
    readonly taxId: string;
    readonly subdomain: string;
    readonly schemaName: string;
    readonly timezone: string;
    readonly planCode: string;
  }): Promise<TenantSummaryDto>;
  /**
   * Marks a client ready, and records that it happened.
   *
   * The implementation MUST write the audit row in the same transaction as the update.
   */
  markProvisioned(tenantId: string, at: Date, audit: LifecycleAudit): Promise<void>;
  /**
   * Suspends or resumes a client without deleting anything (§4).
   *
   * The implementation MUST write the audit row in the same transaction as the update.
   */
  setLifecycleStatus(tenantId: string, status: string, audit: LifecycleAudit): Promise<void>;
}

export interface SchemaProvisioner {
  /** Creates the schema and applies every tenant migration. Safe to run again. */
  provision(input: { readonly tenantId: string; readonly schemaName: string }): Promise<void>;
}

export interface TenantStorageProvisioner {
  provision(tenantId: string): Promise<void>;
}

export interface FirstAdministratorProvisioner {
  /** Creates the client's first administrator, or returns the existing one. */
  provision(input: {
    readonly tenantId: string;
    readonly email: string;
    readonly fullName: string;
  }): Promise<{ readonly email: string; readonly alreadyExisted: boolean }>;
}

export interface ProvisionTenantDependencies {
  readonly pep: PolicyEnforcementPoint;
  readonly tenants: TenantRegistry;
  readonly schemas: SchemaProvisioner;
  readonly storage: TenantStorageProvisioner;
  readonly administrators: FirstAdministratorProvisioner;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface ProvisionTenantCommand extends RegisterTenantInput {
  readonly administratorEmail: string;
  readonly administratorName: string;
}

export interface ProvisionTenantResult {
  readonly tenant: TenantSummaryDto;
  readonly administratorEmail: string;
  /** True when the call finished a provisioning that had already been started. */
  readonly resumed: boolean;
}

export interface TenantProvisioning {
  readonly listTenants: AuthorizedUseCase<Record<string, never>, readonly TenantSummaryDto[]>;
  readonly provisionTenant: AuthorizedUseCase<ProvisionTenantCommand, ProvisionTenantResult>;
  readonly suspendTenant: AuthorizedUseCase<{ readonly tenantId: string }, void>;
  readonly resumeTenant: AuthorizedUseCase<{ readonly tenantId: string }, void>;
}

export function buildTenantProvisioning(
  dependencies: ProvisionTenantDependencies,
): TenantProvisioning {
  const { pep, tenants } = dependencies;

  return {
    listTenants: authorizedUseCase(pep, {
      name: 'ListTenants',
      requirement: requireAll(TENANT_MANAGE),
      handler: () => tenants.list(),
    }),

    provisionTenant: authorizedUseCase(pep, {
      name: 'ProvisionTenant',
      requirement: requireAll(TENANT_MANAGE),
      handler: async (actor: Actor, command) => {
        const registration = prepareTenantRegistration(command);

        // A tax id already registered is almost always the same company typed twice, and
        // provisioning them again would give one company two schemas and split their
        // history in half. The subdomain collision is a different accident with the same
        // cost, so both are refused by name rather than by a database error.
        const existingByTaxId = await tenants.findByTaxId(registration.taxId);
        const existingBySubdomain = await tenants.findBySubdomain(registration.subdomain);

        const existing = existingByTaxId ?? existingBySubdomain;
        if (existing?.isProvisioned === true) {
          throw new TenantAlreadyRegisteredError(
            existingByTaxId === undefined ? 'subdomain' : 'tax_id',
            existingByTaxId === undefined ? registration.subdomain : registration.taxId,
          );
        }

        // Step 1 — the row. A client that exists and is not ready yet.
        const tenant =
          existing ?? (await tenants.register({ id: dependencies.ids.next(), ...registration }));

        // Step 2 — the schema and its migrations.
        await dependencies.schemas.provision({
          tenantId: tenant.id,
          schemaName: tenant.schemaName,
        });

        // Step 3 — the storage prefix.
        await dependencies.storage.provision(tenant.id);

        // Step 4 — the first administrator.
        const administrator = await dependencies.administrators.provision({
          tenantId: tenant.id,
          email: command.administratorEmail,
          fullName: command.administratorName,
        });

        // Step 5 — and only now is the client ready. The trail entry commits with the
        // date: a client that is marked ready with nobody recorded as having done it is
        // exactly the gap §8.4 exists to prevent.
        await tenants.markProvisioned(tenant.id, dependencies.clock.now(), {
          actorId: actor.actorId,
          action: 'tenant.provisioned',
        });

        const provisioned = await tenants.findById(tenant.id);

        return {
          tenant: provisioned ?? tenant,
          administratorEmail: administrator.email,
          resumed: existing !== undefined,
        };
      },
    }),

    suspendTenant: authorizedUseCase(pep, {
      name: 'SuspendTenant',
      requirement: requireAll(TENANT_MANAGE),
      handler: async (actor: Actor, command) => {
        // Suspended, never deleted: business records carry a retention obligation, and a
        // client who leaves may come back or may be audited.
        await tenants.setLifecycleStatus(command.tenantId, 'suspended', {
          actorId: actor.actorId,
          action: 'tenant.suspended',
        });
      },
    }),

    resumeTenant: authorizedUseCase(pep, {
      name: 'ResumeTenant',
      requirement: requireAll(TENANT_MANAGE),
      handler: async (actor: Actor, command) => {
        await tenants.setLifecycleStatus(command.tenantId, 'active', {
          actorId: actor.actorId,
          action: 'tenant.resumed',
        });
      },
    }),
  };
}
