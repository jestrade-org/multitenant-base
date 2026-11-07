-- Baseline for a tenant schema.
--
-- Applied by the tenant migration runner to every active tenant, never by hand
-- (§5.1). The runner substitutes :"schema" with the tenant's schema name, quoted as an
-- identifier by Postgres itself — the name is never string-concatenated into SQL.

-- The browser reaches Supabase only for Auth, Realtime and Storage. Business reads and
-- writes go through the Node API, so no tenant schema is ever exposed to the anon or
-- authenticated roles. Set here, at baseline, so a table added later cannot be born
-- reachable by accident.
revoke all on schema :"schema" from anon, authenticated;

alter default privileges in schema :"schema"
  revoke all on tables from anon, authenticated;
alter default privileges in schema :"schema"
  revoke all on sequences from anon, authenticated;
alter default privileges in schema :"schema"
  revoke all on functions from anon, authenticated;

-- Tenant queries run as tenant_app (no BYPASSRLS), so it needs to see the schema. Table
-- privileges are granted per table by app.install_tenant_isolation, never wholesale.
grant usage on schema :"schema" to tenant_app;

comment on schema :"schema" is 'Tenant data. Reachable only through the Node API.';
