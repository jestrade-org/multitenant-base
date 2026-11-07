-- The release gate stops at the tenant schemas. The control plane is where the
-- cross-tenant data lives.
--
-- `app.tenant_tables_missing_isolation()` sweeps `tenant_%` and fails the build for a table
-- added without isolation. Nothing sweeps `control`, and that is where the rows that span
-- every client sit: who belongs to which company, the audit trail, API keys, and now the
-- support access grants. A table added there without protection is the same bug with a
-- larger blast radius, and today it would ship unnoticed.
--
-- The invariant is not the tenant one. Half of these tables are platform-wide by design —
-- a plan belongs to no company — so "must have a tenant_id and four policies" does not
-- apply. What applies to all of them is narrower and absolute:
--
--   1. row level security is enabled *and* forced, so a policy is required for access and
--      the table's owner is not quietly exempt;
--   2. nothing is granted to `anon` or `authenticated`.
--
-- The second is the one that matters most. Those two roles are what the browser holds: the
-- anon key ships in the bundle by design (`supabase.md`), and it is only safe because
-- nothing it can reach matters. A grant to either on any control table would put the
-- tenant roster, or the audit trail, one query away from a page's JavaScript.
--
-- Ref: Tech specs §4.2, §8.3; supabase.md; security-owasp.md A01.

create or replace function app.control_tables_missing_isolation()
returns table (schema_name text, table_name text, problem text)
language sql
stable
set search_path = ''
as $$
  with control_tables as (
    select c.relname::text as table_name,
           c.oid,
           c.relrowsecurity,
           c.relforcerowsecurity
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'control'
       and c.relkind = 'r'
  )
  select 'control'::text, t.table_name, problem
    from control_tables t
    cross join lateral (
      select case
        when not t.relrowsecurity      then 'row level security is not enabled'
        when not t.relforcerowsecurity then 'row level security is not forced'
        -- Any privilege at all, not just select: an insert grant on `tenant_members` is a
        -- way to give yourself a membership, which is worse than reading one.
        when exists (
          select 1
            from information_schema.role_table_grants g
           where g.table_schema = 'control'
             and g.table_name = t.table_name
             and g.grantee in ('anon', 'authenticated')
        ) then 'reachable by anon or authenticated: the browser holds both'
        else null
      end as problem
    ) checked
   where problem is not null;
$$;

comment on function app.control_tables_missing_isolation() is
  'Release gate for the control plane: every table has RLS enabled and forced, and none is '
  'reachable by the roles the browser holds.';

revoke all on function app.control_tables_missing_isolation() from public;
