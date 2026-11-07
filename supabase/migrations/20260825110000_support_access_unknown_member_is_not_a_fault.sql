-- An id that names nobody is a bad request, not a broken server.
--
-- `control.grant_support_access` raised on an unknown member, and a raise with no mapped
-- SQLSTATE reaches the client as a 500. That is wrong twice over: the caller typed
-- something the system does not recognise, which is a 400, and a 500 tells an operator to
-- investigate an outage that never happened.
--
-- The application layer already models this — the adapter's `open` returns
-- `SupportAccessGrantDto | undefined` and the use case turns the absence into
-- `MemberNotReachableError` — so the function returning no rows is what the code above it
-- was written to expect. The raise was the contradiction.
--
-- The staff check stays a raise. That one is not user input: the route resolved a platform
-- principal before calling this, so reaching it with an id that is not on the roster means
-- the two disagree, and failing loudly is the only honest answer to that.

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

  -- No rows, no grant. The caller reads the absence and answers 400.
  if v_tenant_id is null then
    return;
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

revoke all on function control.grant_support_access(uuid, uuid, text, interval, inet, text)
  from public;
