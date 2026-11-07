-- Shared helpers used by every tenant schema.
--
-- These live in one place rather than being copied into each tenant schema: a security
-- helper duplicated N times is a security helper that will diverge on tenant N+1.

create schema if not exists app;

comment on schema app is
  'Shared functions used by tenant schemas — notably the RLS tenant guard.';

-- The tenant a request is bound to, as set by the resolver middleware (§4.1) on the
-- connection it borrowed. Every tenant-scoped RLS policy validates against this.
--
-- `true` as the second argument makes a missing setting return null instead of raising:
-- a policy comparing against null denies, which is the behaviour we want when the
-- middleware did not run. Deny by default, including on our own mistakes.
create or replace function app.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

comment on function app.current_tenant_id() is
  'Tenant bound to the current connection by the resolver. Returns null when unset, so '
  'a policy comparing against it denies rather than leaks.';

-- Trigger-maintained updated_at for tenant tables.
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on schema app from anon, authenticated;
