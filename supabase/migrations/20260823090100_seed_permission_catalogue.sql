-- The permission catalogue and the base roles.
--
-- This is system reference data, not development fixtures: the application resolves
-- permissions against these rows at runtime, so they ship as a migration rather than in
-- seed.sql. Roles are still *data* — adding a new kind of user is an insert, not a
-- deployment.
--
-- Permissions are capabilities (`iam:user_manage`), never role-string comparisons
-- scattered through the code. A project built on this base adds its own capabilities in a
-- later migration, and mirrors them in `packages/shared-kernel/src/domain/permission.ts`
-- (a test asserts the two lists match).

insert into control.permissions (code, context, description) values
  -- Tenancy & platform
  ('platform:tenant_manage',  'tenancy',      'Create, suspend and terminate company tenants'),
  ('platform:plan_manage',    'tenancy',      'Manage plans and quotas'),
  ('platform:queue_monitor',  'tenancy',      'Inspect job queues, including the dead-letter queue'),
  ('tenancy:read',            'tenancy',      'Read own company profile, plan and quota usage'),

  -- Identity and access
  ('iam:user_manage',         'iam',          'Invite, deactivate and manage users within a company'),
  ('iam:role_manage',         'iam',          'Create roles and assign permissions within a company'),

  -- Integrations
  ('integrations:api_key_manage', 'integrations', 'Create, rotate and revoke API keys'),
  ('integrations:oauth_manage',   'integrations', 'Configure the company identity provider'),

  -- Audit
  ('audit:read',              'audit',        'Read the audit trail for own company'),
  ('audit:read_all',          'audit',        'Read the cross-tenant audit index (platform staff)');

-- ---------------------------------------------------------------- base roles

insert into control.roles (tenant_id, code, name, description, is_system) values
  (null, 'platform_admin', 'Administrador de plataforma',
   'Platform staff. Manages tenants, plans and the role catalogue. No direct access to a '
   'company''s data without an audited, expiring elevation.', true),
  (null, 'platform_operator', 'Operador de plataforma',
   'Platform staff. Monitors job queues. No direct access to a company''s data.', true),
  (null, 'tenant_admin', 'Administrador de la empresa',
   'Manages users and roles within their company, plus identity provider and API keys.', true),
  (null, 'member', 'Miembro',
   'A regular user of the company. Reads the company profile; a project grants the '
   'capabilities of its own modules to this role.', true);

-- ---------------------------------------------------------------- role → permissions

insert into control.role_permissions (role_id, permission_code)
select r.id, p.code
from control.roles r
join lateral (
  values
    ('platform_admin',    'platform:tenant_manage'),
    ('platform_admin',    'platform:plan_manage'),
    ('platform_admin',    'platform:queue_monitor'),
    ('platform_admin',    'audit:read_all'),

    ('platform_operator', 'platform:queue_monitor'),

    ('tenant_admin',      'tenancy:read'),
    ('tenant_admin',      'iam:user_manage'),
    ('tenant_admin',      'iam:role_manage'),
    ('tenant_admin',      'integrations:api_key_manage'),
    ('tenant_admin',      'integrations:oauth_manage'),
    ('tenant_admin',      'audit:read'),

    ('member',            'tenancy:read')
) as grant_list (role_code, permission_code) on grant_list.role_code = r.code
join control.permissions p on p.code = grant_list.permission_code
where r.tenant_id is null;
