-- Platform staff get a role, like everyone else.
--
-- §8.1 keeps platform staff in a separate identity: they are not members of any tenant, and
-- there is no implicit path from being staff to reading a company's data. What was
-- missing is the other half — a platform user with no role has no capabilities, so until
-- now the table could not express "this person may provision a tenant".
--
-- The role is one of the platform-scoped ones (`platform_admin`, `platform_operator`), which
-- live in control.roles with a null tenant_id.

alter table control.platform_users
  add column role_id uuid references control.roles (id) on delete restrict;

create index platform_users_role_idx on control.platform_users (role_id);

/**
 * Resolves a platform principal from a verified token subject.
 *
 * Deliberately separate from `control.resolve_member`. Two functions rather than one with a
 * branch, because the two answers are not interchangeable: a tenant member has a schema and
 * a company, a platform user has neither and must never be handed one by a code path that
 * treated them as the same shape.
 */
create or replace function control.resolve_platform_user(subject uuid)
returns table (
  platform_user_id uuid,
  email            text,
  full_name        text,
  role_code        text,
  permissions      text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id,
         u.email,
         u.full_name,
         r.code,
         coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null),
                  '{}')
    from control.platform_users u
    join control.roles r on r.id = u.role_id
    left join control.role_permissions rp on rp.role_id = r.id
   where u.auth_user_id = subject
     and u.is_active
     -- A platform role has no tenant. Joining a tenant-scoped role here would give staff a
     -- company's capabilities without a company, which is exactly the confusion §8.1
     -- exists to prevent.
     and r.tenant_id is null
   group by u.id, u.email, u.full_name, r.code;
$$;

comment on function control.resolve_platform_user(uuid) is
  'platform staff identity (§8.1). Separate from resolve_member: staff belong to no tenant.';

revoke all on function control.resolve_platform_user(uuid) from public;
