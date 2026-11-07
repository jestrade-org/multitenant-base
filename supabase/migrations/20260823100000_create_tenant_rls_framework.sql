-- Defence 2 of §4.3: Row-Level Security that actually fires.
--
-- There is a trap here worth naming. The API connects with a Supabase role that has
-- BYPASSRLS, which is what lets it read the control plane. If tenant queries also ran
-- under that role, every RLS policy on every tenant table would be decorative: the
-- second defence would exist on paper and never once evaluate.
--
-- So tenant work runs as `tenant_app`, a role with no BYPASSRLS and no ownership of
-- anything. The connection provider switches to it with `SET LOCAL ROLE` inside the same
-- transaction that binds the schema, so it reverts automatically at commit or rollback —
-- the same reasoning as `SET LOCAL search_path`.
--
-- Ref: Tech specs §4.3, §5, §8.3.

-- ---------------------------------------------------------------- the application role

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tenant_app') then
    create role tenant_app nologin;
  end if;
end;
$$;

comment on role tenant_app is
  'Role tenant queries run as. No BYPASSRLS, owns nothing: RLS policies are evaluated '
  'against it, which is the entire point of defence 2 (§4.3).';

-- The connecting user must be a member of tenant_app to SET ROLE to it.
grant tenant_app to postgres;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant tenant_app to service_role';
  end if;
end;
$$;

grant usage on schema app to tenant_app;
grant execute on function app.current_tenant_id() to tenant_app;

-- ---------------------------------------------------------------- the policy template

/**
 * Installs the standard tenant isolation policies on one table.
 *
 * Every tenant table calls this instead of hand-writing policies. A policy written by
 * hand on the fifteenth table is a policy that will differ from the other fourteen, and
 * the difference will be discovered by an incident rather than a review.
 *
 * Deliberately four separate policies rather than one `for all`: a single policy hides
 * which operations it was meant to cover, and over-grants by default. `with check` on
 * insert and update is what stops a caller writing a row *into another tenant*.
 */
create or replace function app.install_tenant_isolation(target_schema text, target_table text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  qualified text := format('%I.%I', target_schema, target_table);
  policy_prefix text := target_table;
begin
  if to_regclass(qualified) is null then
    raise exception 'Cannot install tenant isolation: %.% does not exist',
      target_schema, target_table;
  end if;

  -- The table must carry the tenant it belongs to. Without the column there is nothing
  -- for a policy to compare, and "isolated because it lives in the right schema" is
  -- exactly the single point of failure defence 2 exists to remove.
  if not exists (
    select 1 from pg_attribute a
     where a.attrelid = qualified::regclass
       and a.attname = 'tenant_id'
       and not a.attisdropped
  ) then
    raise exception 'Cannot install tenant isolation: %.% has no tenant_id column',
      target_schema, target_table;
  end if;

  execute format('alter table %s enable row level security', qualified);
  execute format('alter table %s force row level security', qualified);

  execute format('drop policy if exists %I on %s', policy_prefix || '_tenant_select', qualified);
  execute format('drop policy if exists %I on %s', policy_prefix || '_tenant_insert', qualified);
  execute format('drop policy if exists %I on %s', policy_prefix || '_tenant_update', qualified);
  execute format('drop policy if exists %I on %s', policy_prefix || '_tenant_delete', qualified);

  execute format(
    'create policy %I on %s for select to tenant_app using (tenant_id = app.current_tenant_id())',
    policy_prefix || '_tenant_select', qualified);
  execute format(
    'create policy %I on %s for insert to tenant_app with check (tenant_id = app.current_tenant_id())',
    policy_prefix || '_tenant_insert', qualified);
  execute format(
    'create policy %I on %s for update to tenant_app using (tenant_id = app.current_tenant_id()) '
    'with check (tenant_id = app.current_tenant_id())',
    policy_prefix || '_tenant_update', qualified);
  execute format(
    'create policy %I on %s for delete to tenant_app using (tenant_id = app.current_tenant_id())',
    policy_prefix || '_tenant_delete', qualified);

  -- Policies run per row, so the column they filter on is indexed. Without this, tenant
  -- isolation is also a sequential scan.
  execute format('create index if not exists %I on %s (tenant_id)',
    policy_prefix || '_tenant_id_idx', qualified);

  execute format('grant select, insert, update, delete on %s to tenant_app', qualified);
end;
$$;

comment on function app.install_tenant_isolation(text, text) is
  'Installs the four standard tenant isolation policies, forces RLS, indexes tenant_id '
  'and grants the application role. Every tenant table uses this; none hand-writes them.';

-- ---------------------------------------------------------------- the guard

/**
 * Lists tenant tables that are not properly isolated.
 *
 * A table without RLS is a bug, so this is not documentation — `pnpm verify:rls` runs it
 * in CI and fails the build on any row. The moment someone adds a table and forgets the
 * policies, the build stops rather than the data leaking.
 */
create or replace function app.tenant_tables_missing_isolation()
returns table (schema_name text, table_name text, problem text)
language sql
stable
set search_path = ''
as $$
  with tenant_tables as (
    select n.nspname::text as schema_name,
           c.relname::text as table_name,
           c.oid,
           c.relrowsecurity,
           c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname like 'tenant\_%'
       and c.relkind = 'r'
       -- The runner's own bookkeeping is not tenant data: it lives inside the tenant's
       -- schema and is never reachable through the application role.
       and c.relname <> 'applied_migrations'
  )
  select t.schema_name, t.table_name, problem
    from tenant_tables t
    cross join lateral (
      select case
        when not exists (
          select 1 from pg_attribute a
           where a.attrelid = t.oid and a.attname = 'tenant_id' and not a.attisdropped
        ) then 'no tenant_id column to isolate on'
        when not t.relrowsecurity      then 'row level security is not enabled'
        when not t.relforcerowsecurity then 'row level security is not forced'
        when (select count(*) from pg_policy p where p.polrelid = t.oid) < 4
             then 'fewer than four policies: one per operation is required'
        else null
      end as problem
    ) checked
   where problem is not null;
$$;
