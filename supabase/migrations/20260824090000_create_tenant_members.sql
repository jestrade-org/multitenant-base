-- Who belongs to which company, and as what.
--
-- Authentication says *who is asking* (Supabase Auth issues the token). This table says
-- *which company they are asking about* and *what they may do there* — the two questions
-- §8.1 and §8.3 keep apart on purpose. Conflating them is how a user of one company ends
-- up reading another's data because the token happened to be valid.
--
-- It lives in the control plane rather than in a tenant schema because the login flow has
-- to resolve a member *before* any tenant is bound: at that point there is no schema to
-- look in.
--
-- Ref: Tech specs §4.1, §8.1, §8.3.

create table control.tenant_members (
  id            uuid primary key default gen_random_uuid(),

  tenant_id     uuid not null references control.tenants (id) on delete cascade,

  -- The canonical identity, from auth.users. Never the email: people change theirs, and
  -- two companies can legitimately have a person with the same address.
  auth_user_id  uuid not null,

  -- Kept for display and for support to find someone. Not an identifier.
  email         text not null,
  full_name     text not null,

  role_id       uuid not null references control.roles (id) on delete restrict,

  is_active     boolean not null default true,
  last_seen_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint tenant_members_email_shape check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

create trigger tenant_members_set_updated_at
  before update on control.tenant_members
  for each row execute function control.set_updated_at();

-- One membership per person per company. A second row would make "which role does this
-- user have here" ambiguous, and an ambiguous authorization answer is a denied one at
-- best and a granted one at worst.
create unique index tenant_members_unique_membership
  on control.tenant_members (tenant_id, auth_user_id);

-- The login lookup: given a verified auth user, which companies may they enter?
create index tenant_members_auth_user_idx
  on control.tenant_members (auth_user_id) where is_active;

create index tenant_members_tenant_idx on control.tenant_members (tenant_id);
create index tenant_members_role_idx   on control.tenant_members (role_id);

alter table control.tenant_members enable row level security;
alter table control.tenant_members force row level security;
revoke all on control.tenant_members from anon, authenticated;

comment on table control.tenant_members is
  'Links a verified Supabase Auth identity to a tenant and a role. Authentication says '
  'who; this says where and what they may do.';

/**
 * Resolves a verified auth user to their membership.
 *
 * One query rather than three round trips, because it runs on every authenticated
 * request: the API cannot trust a client-supplied tenant, so it re-derives the membership
 * from the token's subject each time (§8.1).
 */
create or replace function control.resolve_member(p_auth_user_id uuid)
returns table (
  member_id     uuid,
  tenant_id     uuid,
  tenant_name   text,
  schema_name   text,
  subdomain     text,
  timezone      text,
  lifecycle     control.tenant_lifecycle_status,
  isolation     control.tenant_isolation_mode,
  role_code     text,
  full_name     text,
  email         text,
  permissions   text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    m.id, t.id, t.name, t.schema_name, t.subdomain, t.timezone,
    t.lifecycle_status, t.isolation_mode, r.code, m.full_name, m.email,
    coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null), '{}')
  from control.tenant_members m
  join control.tenants t on t.id = m.tenant_id
  join control.roles   r on r.id = m.role_id
  left join control.role_permissions rp on rp.role_id = r.id
  where m.auth_user_id = p_auth_user_id
    and m.is_active
    and t.lifecycle_status not in ('terminated', 'suspended')
  group by m.id, t.id, r.code, m.full_name, m.email;
$$;

comment on function control.resolve_member(uuid) is
  'Membership, role and effective permissions for a verified auth user. Re-derived from '
  'the token subject on every request; never taken from the client.';
