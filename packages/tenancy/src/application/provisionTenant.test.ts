import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FixedClock,
  NotAuthorizedError,
  permission,
  PolicyEnforcementPoint,
  SequentialIdGenerator,
  type Actor,
  type AuthorizationAuditSink,
} from '@multitenant-base/shared-kernel';

import {
  buildTenantProvisioning,
  type LifecycleAudit,
  type ProvisionTenantCommand,
  type TenantProvisioning,
  type TenantRegistry,
  type TenantSummaryDto,
} from './provisionTenant.js';
import { TenantAlreadyRegisteredError } from '../domain/tenantRegistration.js';

/**
 * §4's five steps, and the property that replaces an orchestrator at this scale: every one
 * of them is safe to run again.
 */

const CLOCK = new FixedClock('2026-08-24T15:00:00.000Z');
const silentAudit: AuthorizationAuditSink = { record: () => Promise.resolve() };

class InMemoryTenantRegistry implements TenantRegistry {
  public readonly rows = new Map<string, TenantSummaryDto>();
  /** What the real adapter would have written to the trail, in the same transaction. */
  public readonly audited: { tenantId: string; actorId: string; action: string }[] = [];

  public findByTaxId(taxId: string): Promise<TenantSummaryDto | undefined> {
    return Promise.resolve([...this.rows.values()].find((row) => row.taxId === taxId));
  }

  public findBySubdomain(subdomain: string): Promise<TenantSummaryDto | undefined> {
    return Promise.resolve([...this.rows.values()].find((row) => row.subdomain === subdomain));
  }

  public findById(tenantId: string): Promise<TenantSummaryDto | undefined> {
    return Promise.resolve(this.rows.get(tenantId));
  }

  public list(): Promise<readonly TenantSummaryDto[]> {
    return Promise.resolve([...this.rows.values()]);
  }

  public register(input: {
    id: string;
    name: string;
    taxId: string;
    subdomain: string;
    schemaName: string;
    timezone: string;
    planCode: string;
  }): Promise<TenantSummaryDto> {
    const row: TenantSummaryDto = {
      ...input,
      lifecycleStatus: 'onboarding',
      isProvisioned: false,
      createdAt: '2026-08-24T15:00:00.000Z',
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  public markProvisioned(tenantId: string, _at: Date, audit: LifecycleAudit): Promise<void> {
    const row = this.rows.get(tenantId);
    if (row !== undefined) this.rows.set(tenantId, { ...row, isProvisioned: true });
    this.audited.push({ tenantId, ...audit });
    return Promise.resolve();
  }

  public setLifecycleStatus(
    tenantId: string,
    status: string,
    audit: LifecycleAudit,
  ): Promise<void> {
    const row = this.rows.get(tenantId);
    if (row !== undefined) this.rows.set(tenantId, { ...row, lifecycleStatus: status });
    this.audited.push({ tenantId, ...audit });
    return Promise.resolve();
  }
}

function anActor(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: 'platform-admin-1',
    actorType: 'platform_admin',
    // Staff belong to no tenant, and the fixture says so literally: a placeholder here is
    // how a string like 'platform' ends up in a uuid column.
    tenantId: undefined,
    roleCode: 'platform_admin',
    permissions: [permission('platform:tenant_manage')],
    ...overrides,
  };
}

const COMMAND: ProvisionTenantCommand = {
  name: 'Servicios Portuarios Marítimos S.A.S.',
  taxId: '98-7654321',
  planCode: 'essential',
  administratorEmail: 'admin@servipormac.co',
  administratorName: 'Luis Alberto Henríquez',
};

let registry: InMemoryTenantRegistry;
let provisioning: TenantProvisioning;
let schemas: { provision: ReturnType<typeof vi.fn> };
let storage: { provision: ReturnType<typeof vi.fn> };
let administrators: { provision: ReturnType<typeof vi.fn> };

beforeEach(() => {
  registry = new InMemoryTenantRegistry();
  schemas = { provision: vi.fn(() => Promise.resolve()) };
  storage = { provision: vi.fn(() => Promise.resolve()) };
  administrators = {
    provision: vi.fn(() =>
      Promise.resolve({ email: 'admin@servipormac.co', alreadyExisted: false }),
    ),
  };

  provisioning = buildTenantProvisioning({
    pep: new PolicyEnforcementPoint({ clock: CLOCK, auditSink: silentAudit }),
    tenants: registry,
    schemas,
    storage,
    administrators,
    ids: new SequentialIdGenerator('tenant'),
    clock: CLOCK,
  });
});

describe('who may provision a client', () => {
  it('refuses anyone without platform:tenant_manage', async () => {
    const operator = anActor({ permissions: [permission('platform:queue_monitor')] });

    await expect(provisioning.provisionTenant(operator, COMMAND)).rejects.toThrow(
      NotAuthorizedError,
    );
  });

  it('refuses a tenant administrator, however senior', async () => {
    // Creating a client is a platform act. A tenant's own admin has no business doing it,
    // and `iam:role_manage` is not a step towards it.
    const tenantAdmin = anActor({
      roleCode: 'tenant_admin',
      permissions: [permission('iam:role_manage'), permission('iam:user_manage')],
    });

    await expect(provisioning.provisionTenant(tenantAdmin, COMMAND)).rejects.toThrow(
      NotAuthorizedError,
    );
  });
});

describe('the five steps of §4', () => {
  it('runs them in order and marks the client ready only at the end', async () => {
    const result = await provisioning.provisionTenant(anActor(), COMMAND);

    expect(result.tenant.schemaName).toBe(
      'tenant_servicios-portuarios-maritimos'.replace(/-/g, '_'),
    );
    expect(schemas.provision).toHaveBeenCalledOnce();
    expect(storage.provision).toHaveBeenCalledOnce();
    expect(administrators.provision).toHaveBeenCalledOnce();
    expect(result.tenant.isProvisioned).toBe(true);
    expect(registry.audited).toEqual([
      {
        tenantId: expect.any(String) as unknown,
        actorId: 'platform-admin-1',
        action: 'tenant.provisioned',
      },
    ]);
  });

  it('normalises the tax identifier on the way in', async () => {
    const result = await provisioning.provisionTenant(anActor(), COMMAND);

    expect(result.tenant.taxId).toBe('987654321');
  });

  it('does not mark it ready when a step fails', async () => {
    // The visible state of "something stopped": a row with no provisioning date. An
    // operator can see it and finish it.
    schemas.provision = vi.fn(() => Promise.reject(new Error('migrations failed')));

    await expect(provisioning.provisionTenant(anActor(), COMMAND)).rejects.toThrow(
      'migrations failed',
    );

    const rows = await registry.list();
    expect(rows[0]?.isProvisioned).toBe(false);
    // Nothing to record: a provisioning that stopped before step 5 never said "ready".
    expect(registry.audited).toEqual([]);
  });
});

describe('running it again', () => {
  it('finishes a provisioning that stopped halfway, without a second row', async () => {
    // No orchestrator with rollback at this scale (§19.1). What replaces it is that
    // pressing the button again lands in the same place.
    schemas.provision = vi.fn(() => Promise.reject(new Error('migrations failed')));
    await expect(provisioning.provisionTenant(anActor(), COMMAND)).rejects.toThrow();

    schemas.provision = vi.fn(() => Promise.resolve());
    const result = await provisioning.provisionTenant(anActor(), COMMAND);

    expect(result.resumed).toBe(true);
    expect(result.tenant.isProvisioned).toBe(true);
    expect(await registry.list()).toHaveLength(1);
  });

  it('refuses to provision a client that is already finished', async () => {
    // Two schemas for one company would split their history in half.
    await provisioning.provisionTenant(anActor(), COMMAND);

    await expect(provisioning.provisionTenant(anActor(), COMMAND)).rejects.toThrow(
      TenantAlreadyRegisteredError,
    );
  });

  it('refuses a different company that would take an existing subdomain', async () => {
    await provisioning.provisionTenant(anActor(), COMMAND);

    await expect(
      provisioning.provisionTenant(anActor(), {
        ...COMMAND,
        taxId: '12-3456789',
        subdomain: 'servicios-portuarios-maritimos',
      }),
    ).rejects.toThrow(TenantAlreadyRegisteredError);
  });
});

describe('suspending a client', () => {
  it('changes their status without deleting anything', async () => {
    // Financial records carry a six-year retention, and a client who leaves may be audited.
    const { tenant } = await provisioning.provisionTenant(anActor(), COMMAND);

    await provisioning.suspendTenant(anActor(), { tenantId: tenant.id });

    expect((await registry.findById(tenant.id))?.lifecycleStatus).toBe('suspended');
    expect(await registry.list()).toHaveLength(1);
  });

  it('can be undone', async () => {
    const { tenant } = await provisioning.provisionTenant(anActor(), COMMAND);
    await provisioning.suspendTenant(anActor(), { tenantId: tenant.id });

    await provisioning.resumeTenant(anActor(), { tenantId: tenant.id });

    expect((await registry.findById(tenant.id))?.lifecycleStatus).toBe('active');
  });

  it('refuses an actor without the capability', async () => {
    const { tenant } = await provisioning.provisionTenant(anActor(), COMMAND);
    const operator = anActor({ permissions: [permission('platform:queue_monitor')] });

    await expect(provisioning.suspendTenant(operator, { tenantId: tenant.id })).rejects.toThrow(
      NotAuthorizedError,
    );
  });
});
