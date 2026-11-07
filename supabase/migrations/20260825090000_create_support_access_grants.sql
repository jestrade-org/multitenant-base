-- Support access: platform staff acting inside a client's account (§8.1, VC-101).
--
-- The rule §8.1 sets is that staff belong to no company and have no implicit path to one.
-- This is the explicit path, and it is deliberately not a login: nothing here mints a
-- credential for the client's user, and the staff member's own token is the only one that
-- ever exists. What a grant does is tell the API "for the next few minutes, resolve this
-- staff member's requests as this member of this company" — a server-side overlay on their
-- own session, revocable by deleting one row.
--
-- That shape is what keeps §8.4 honest. "Every human action must be attributable to one
-- human" does not survive a feature that makes one person indistinguishable from another,
-- so the grant is recorded, the trail names both people, and the interface says so on
-- every screen for as long as it lasts.
--
-- Ref: Tech specs §8.1, §8.4; security-iaaa.md.

create table control.support_access_grants (
  id               uuid primary key default gen_random_uuid(),

  -- Who is reaching in. Restrict rather than cascade: a staff member who leaves does not
  -- take the record of what they did with them (six-year retention, §8.4).
  platform_user_id uuid not null references control.platform_users (id) on delete restrict,

  -- Whose account, and as whom. Both, rather than deriving the tenant from the member:
  -- the pair is what the audit trail reads, and a membership that later moves must not
  -- silently rewrite history.
  tenant_id        uuid not null references control.tenants (id)        on delete restrict,
  member_id        uuid not null references control.tenant_members (id) on delete restrict,

  -- Why. Required, and long enough to be a sentence: "support" tells a reviewer nothing
  -- six months later, and this row is the only place the reason is ever captured.
  reason           text not null,

  started_at       timestamptz not null default now(),

  -- Every grant expires. A support session that outlives the conversation it was opened
  -- for is a standing key to a company's data.
  expires_at       timestamptz not null,

  -- Set when the staff member returns to their own profile, or when a later grant
  -- supersedes this one. Null means live.
  ended_at         timestamptz,

  ip_address       inet,
  correlation_id   text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint support_access_reason_bounded
    check (length(btrim(reason)) between 10 and 500),
  constraint support_access_window
    check (expires_at > started_at),
  constraint support_access_ended_after_start
    check (ended_at is null or ended_at >= started_at)
);

create trigger support_access_grants_set_updated_at
  before update on control.support_access_grants
  for each row execute function control.set_updated_at();

-- One live grant per staff member. Two would make "who is this request" ambiguous, and an
-- ambiguous identity is the one thing this table exists to prevent.
create unique index support_access_grants_one_live_per_staff
  on control.support_access_grants (platform_user_id)
  where ended_at is null;

-- The lookup that runs on every authenticated request from a staff member.
create index support_access_grants_live_idx
  on control.support_access_grants (platform_user_id, expires_at)
  where ended_at is null;

-- The reviewer's query: everything anyone did inside this client.
create index support_access_grants_tenant_idx
  on control.support_access_grants (tenant_id, started_at desc);

alter table control.support_access_grants enable row level security;
alter table control.support_access_grants force row level security;
revoke all on control.support_access_grants from anon, authenticated;

comment on table control.support_access_grants is
  'An expiring, audited grant letting platform staff act as one member of one client (VC-101). '
  'Not a login: no credential is issued for the client user, and the grant is revocable.';

/**
 * A grant is a record, not a working document.
 *
 * Only `ended_at` may ever change, and only from null. Everything else is what was true
 * when someone reached into a client's account, and a row that can be edited afterwards is
 * not evidence of anything.
 */
create or replace function control.reject_support_access_rewrite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'a support access grant that has ended cannot be reopened (grant %)', old.id
      using errcode = 'restrict_violation';
  end if;

  if (new.id, new.platform_user_id, new.tenant_id, new.member_id, new.reason,
      new.started_at, new.expires_at, new.ip_address, new.correlation_id, new.created_at)
     is distinct from
     (old.id, old.platform_user_id, old.tenant_id, old.member_id, old.reason,
      old.started_at, old.expires_at, old.ip_address, old.correlation_id, old.created_at)
  then
    raise exception 'only ended_at may be changed on a support access grant (grant %)', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger support_access_grants_append_only
  before update on control.support_access_grants
  for each row execute function control.reject_support_access_rewrite();

create or replace function control.reject_support_access_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'control.support_access_grants is append-only (grant %)', old.id
    using errcode = 'restrict_violation';
end;
$$;

create trigger support_access_grants_no_delete
  before delete on control.support_access_grants
  for each row execute function control.reject_support_access_delete();

-- ------------------------------------------------------------------ the capability

-- Reaching into a client's account is its own capability, held by nobody by default. It is
-- not implied by `platform:tenant_manage`: provisioning a company and reading its cash
-- position are different powers, and bundling them would hand the second to everyone who
-- needed the first.
insert into control.permissions (code, context, description) values
  ('platform:support_access',
   'platform',
   'Act inside a client account as one of its members, for a bounded and audited period')
on conflict (code) do nothing;

-- Granted to the platform administrator only. The analyst role provisions and monitors;
-- it does not get to read a company's data as one of their own people.
insert into control.role_permissions (role_id, permission_code)
select r.id, 'platform:support_access'
  from control.roles r
 where r.tenant_id is null
   and r.code = 'platform_admin'
on conflict do nothing;

-- ------------------------------------------------------------------ resolution

/**
 * The live grant for a verified staff member, with the membership it points at.
 *
 * Returns the same shape `control.resolve_member` does, so the authentication layer binds
 * a support session through exactly the code path a real member goes through — a second,
 * parallel resolution is how the two drift until one of them forgets a check.
 *
 * Expiry is applied here rather than by a job: a grant nobody cleaned up must stop working
 * on its own, at the moment it expires, not at the next sweep.
 */
create or replace function control.resolve_support_access(subject uuid)
returns table (
  grant_id      uuid,
  expires_at    timestamptz,
  reason        text,
  member_id     uuid,
  tenant_id     uuid,
  tenant_name   text,
  schema_name   text,
  subdomain     text,
  timezone      text,
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
  select g.id, g.expires_at, g.reason,
         m.id, t.id, t.name, t.schema_name, t.subdomain, t.timezone,
         r.code, m.full_name, m.email,
         coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null),
                  '{}')
    from control.support_access_grants g
    join control.platform_users u on u.id = g.platform_user_id
    join control.tenant_members  m on m.id = g.member_id
    join control.tenants         t on t.id = m.tenant_id
    join control.roles           r on r.id = m.role_id
    left join control.role_permissions rp on rp.role_id = r.id
   where u.auth_user_id = subject
     and u.is_active
     and g.ended_at is null
     and g.expires_at > now()
     -- The membership has to still be live. A grant outliving the account it points at
     -- would be a way to keep reading a company through a person who was removed from it.
     and m.is_active
     and t.lifecycle_status not in ('terminated', 'suspended')
   group by g.id, m.id, t.id, r.code, m.full_name, m.email;
$$;

comment on function control.resolve_support_access(uuid) is
  'The live, unexpired support access grant for a staff member, resolved to the membership '
  'it acts as. Same shape as resolve_member, so both bind through one code path.';

revoke all on function control.resolve_support_access(uuid) from public;

/**
 * Opens a grant.
 *
 * Closes whatever the staff member had open first, so the unique index holds and so
 * "switch to a different client" cannot leave two live grants behind. Returns the row the
 * caller audits.
 */
create or replace function control.grant_support_access(
  p_auth_user_id   uuid,
  p_member_id      uuid,
  p_reason         text,
  p_duration       interval,
  p_ip             inet,
  p_correlation_id text
)
returns table (
  grant_id     uuid,
  tenant_id    uuid,
  tenant_name  text,
  member_id    uuid,
  member_name  text,
  member_email text,
  role_code    text,
  expires_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform_user_id uuid;
  v_tenant_id        uuid;
  v_grant_id         uuid;
  v_expires_at       timestamptz;
begin
  select u.id into v_platform_user_id
    from control.platform_users u
   where u.auth_user_id = p_auth_user_id and u.is_active;

  if v_platform_user_id is null then
    raise exception 'not a platform user' using errcode = 'insufficient_privilege';
  end if;

  -- The membership has to exist, be live, and belong to a company that is still served.
  select m.tenant_id into v_tenant_id
    from control.tenant_members m
    join control.tenants t on t.id = m.tenant_id
   where m.id = p_member_id
     and m.is_active
     and t.lifecycle_status not in ('terminated', 'suspended');

  if v_tenant_id is null then
    raise exception 'no such member' using errcode = 'no_data_found';
  end if;

  update control.support_access_grants
     set ended_at = now()
   where platform_user_id = v_platform_user_id
     and ended_at is null;

  v_expires_at := now() + p_duration;

  insert into control.support_access_grants
    (platform_user_id, tenant_id, member_id, reason, expires_at, ip_address, correlation_id)
  values
    (v_platform_user_id, v_tenant_id, p_member_id, p_reason, v_expires_at, p_ip, p_correlation_id)
  returning id into v_grant_id;

  return query
    select v_grant_id, t.id, t.name, m.id, m.full_name, m.email, r.code, v_expires_at
      from control.tenant_members m
      join control.tenants t on t.id = m.tenant_id
      join control.roles   r on r.id = m.role_id
     where m.id = p_member_id;
end;
$$;

comment on function control.grant_support_access(uuid, uuid, text, interval, inet, text) is
  'Opens an expiring support access grant, closing any the staff member already had open.';

revoke all on function control.grant_support_access(uuid, uuid, text, interval, inet, text)
  from public;

/**
 * Closes the live grant, and says whether there was one.
 *
 * Idempotent: returning to your own profile twice is not an error, and a client that
 * retries the request must not be told something went wrong.
 */
create or replace function control.end_support_access(p_auth_user_id uuid)
returns table (
  grant_id  uuid,
  tenant_id uuid,
  member_id uuid
)
language sql
security definer
set search_path = ''
as $$
  update control.support_access_grants g
     set ended_at = now()
    from control.platform_users u
   where u.id = g.platform_user_id
     and u.auth_user_id = p_auth_user_id
     and g.ended_at is null
  returning g.id, g.tenant_id, g.member_id;
$$;

comment on function control.end_support_access(uuid) is
  'Ends the staff member''s live support access grant. Idempotent: no live grant is not an error.';

revoke all on function control.end_support_access(uuid) from public;

/**
 * The people a staff member can reach, for the search box that opens a grant.
 *
 * Returns identifiers and names — never any business data. Finding a person is not the
 * same power as reading their company's books, and this is the only query that runs before
 * a grant exists.
 */
create or replace function control.search_tenant_members(
  p_query     text,
  p_tenant_id uuid,
  p_limit     int
)
returns table (
  member_id   uuid,
  full_name   text,
  email       text,
  role_code   text,
  tenant_id   uuid,
  tenant_name text,
  is_active   boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.full_name, m.email, r.code, t.id, t.name, m.is_active
    from control.tenant_members m
    join control.tenants t on t.id = m.tenant_id
    join control.roles   r on r.id = m.role_id
   where m.is_active
     and t.lifecycle_status not in ('terminated', 'suspended')
     and (p_tenant_id is null or t.id = p_tenant_id)
     and (
       p_query is null
       or m.full_name ilike '%' || p_query || '%'
       or m.email     ilike '%' || p_query || '%'
       or t.name      ilike '%' || p_query || '%'
     )
   order by t.name, m.full_name
   limit least(greatest(p_limit, 1), 50);
$$;

comment on function control.search_tenant_members(text, uuid, int) is
  'Name, address, role and company of tenant members, for the support access search — '
  'either across every client or within one. Carries no business data.';

revoke all on function control.search_tenant_members(text, uuid, int) from public;
