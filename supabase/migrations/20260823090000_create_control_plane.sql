-- Control plane: the platform's own registry.
--
-- This schema holds what is true *about* tenants (companies) — who they are, what plan
-- they are on, which schema holds their data, which API keys and identity provider they
-- use. It never holds a tenant's business data: that lives in the tenant's own schema
-- (schema-per-tenant isolation).
--
-- The separation is what lets platform staff operate the product — see quota usage,
-- monitor queues, read the audit index across tenants — without having any implicit
-- read path into a company's data.

create schema if not exists control;

comment on schema control is
  'Platform registry: tenants, plans, platform identities, API keys, OAuth2 config. '
  'Never contains tenant business data.';

-- ---------------------------------------------------------------- shared helpers

-- Trigger-maintained updated_at, so the column cannot drift when someone updates a row
-- without remembering to set it. security invoker by default; search_path pinned because
-- this function is called from triggers on tables in another schema.
create or replace function control.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- enums

-- The lifecycle a company moves through. Adding a value is a migration; removing one is a
-- breaking change.
create type control.tenant_lifecycle_status as enum (
  'onboarding',  -- registered and provisioning; the first administrator is invited
  'active',      -- steady state
  'suspended',   -- access retained, processing paused
  'terminated'   -- contract ended; retention rules apply
);

-- How a tenant's data is isolated. The application never branches on this: the tenant
-- resolver reads it and hands back a connection either way.
create type control.tenant_isolation_mode as enum (
  'shared_schema',    -- dedicated Postgres schema in the shared project
  'dedicated_project' -- its own Supabase project (reserved; not implemented)
);

create type control.api_key_environment as enum ('live', 'test');

-- ---------------------------------------------------------------- plans and quotas

create table control.plans (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,
  name                  text not null,

  -- Money is never a float. numeric(19,4) here, a string on the wire, a Money value
  -- object in the domain.
  monthly_price         numeric(19, 4) not null,
  currency              text not null default 'USD',

  -- Enforced as a quota policy in the application layer, not as a database constraint:
  -- exceeding a quota must produce a typed business error and an alert, not a constraint
  -- violation surfaced as a 500. A project adds its own limits as further max_* columns.
  max_users             integer not null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint plans_code_is_slug        check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint plans_currency_is_iso4217 check (currency ~ '^[A-Z]{3}$'),
  constraint plans_price_not_negative  check (monthly_price >= 0),
  constraint plans_quotas_positive     check (max_users > 0)
);

create trigger plans_set_updated_at
  before update on control.plans
  for each row execute function control.set_updated_at();

-- ---------------------------------------------------------------- tenants

create table control.tenants (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,

  -- The company's tax or legal registration number, in whatever jurisdiction it is
  -- registered. Stored normalised (uppercase letters and digits, no separators) so the
  -- same company typed two ways is recognised as one.
  tax_id           text not null unique,

  -- restrict, never cascade: deleting a plan must not be able to take tenants with it.
  plan_id          uuid not null references control.plans (id) on delete restrict,

  lifecycle_status control.tenant_lifecycle_status not null default 'onboarding',
  isolation_mode   control.tenant_isolation_mode   not null default 'shared_schema',

  -- The Postgres schema holding this tenant's data. Never interpolated into SQL from a
  -- request: the resolver looks it up here and the repositories bind it.
  schema_name      text not null unique,

  -- Subdomain used as the second-precedence tenant hint.
  subdomain        text not null unique,

  -- Company timezone. Day and month boundaries for the company are computed here, not on
  -- the server or in the browser.
  timezone         text not null default 'UTC',

  provisioned_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint tenants_tax_id_format      check (tax_id ~ '^[A-Z0-9]{3,30}$'),
  -- A schema name reaches SQL as an identifier. Constrain it at the database level so a
  -- malformed value cannot exist to be interpolated in the first place.
  constraint tenants_schema_name_format check (schema_name ~ '^tenant_[a-z0-9_]{1,40}$'),
  constraint tenants_subdomain_format   check (subdomain ~ '^[a-z0-9][a-z0-9-]{1,60}$')
);

create trigger tenants_set_updated_at
  before update on control.tenants
  for each row execute function control.set_updated_at();

-- Every foreign key gets an index; so does every column a policy or hot filter uses.
create index tenants_plan_id_idx          on control.tenants (plan_id);
create index tenants_lifecycle_status_idx on control.tenants (lifecycle_status);

comment on column control.tenants.schema_name is
  'Postgres schema holding this tenant''s data. Resolved server-side from the verified '
  'token or subdomain; never taken from a request payload.';

-- ---------------------------------------------------------------- platform identities

-- Platform staff. A separate identity from any tenant user, with no implicit access to any
-- tenant's data: support access to a company is a separate, audited, expiring grant.
create table control.platform_users (
  id           uuid primary key default gen_random_uuid(),

  -- The canonical user id from Supabase Auth. Never identify a person by email, tax id or
  -- name — those change and repeat.
  auth_user_id uuid not null unique,

  email        text not null unique,
  full_name    text not null,
  is_active    boolean not null default true,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint platform_users_email_shape check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

create trigger platform_users_set_updated_at
  before update on control.platform_users
  for each row execute function control.set_updated_at();

-- ---------------------------------------------------------------- roles and permissions

-- The permission catalogue is data, not constants in code, so a tenant can be given a
-- new kind of user without a deployment.
create table control.permissions (
  code        text primary key,
  -- Bounded context the permission belongs to: tenancy, iam, integrations, audit...
  context     text not null,
  description text not null,
  created_at  timestamptz not null default now(),

  constraint permissions_code_format check (code ~ '^[a-z_]+:[a-z_*]+$')
);

create table control.roles (
  id          uuid primary key default gen_random_uuid(),

  -- null for the platform-wide base roles seeded below; set for a role a tenant admin
  -- creates for their own company.
  tenant_id   uuid references control.tenants (id) on delete cascade,

  code        text not null,
  name        text not null,
  description text not null default '',
  is_system   boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint roles_code_is_slug check (code ~ '^[a-z][a-z0-9_]{1,40}$')
);

-- A tenant may not shadow a base role's code, and may not define the same code twice.
create unique index roles_platform_code_idx
  on control.roles (code) where tenant_id is null;
create unique index roles_tenant_code_idx
  on control.roles (tenant_id, code) where tenant_id is not null;
create index roles_tenant_id_idx on control.roles (tenant_id);

create trigger roles_set_updated_at
  before update on control.roles
  for each row execute function control.set_updated_at();

create table control.role_permissions (
  role_id         uuid not null references control.roles (id)       on delete cascade,
  permission_code text not null references control.permissions (code) on delete restrict,
  granted_at      timestamptz not null default now(),

  primary key (role_id, permission_code)
);

create index role_permissions_permission_code_idx
  on control.role_permissions (permission_code);

-- ---------------------------------------------------------------- API keys

create table control.api_keys (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references control.tenants (id) on delete restrict,

  environment     control.api_key_environment not null,

  -- Public, human-readable identifier: mtb_live_..., mtb_test_...
  key_prefix      text not null unique,

  -- Hash of the secret. The secret itself is shown once at creation and never stored.
  secret_hash     text not null,

  name            text not null,

  -- An explicit subset of the permission catalogue. A key never inherits everything the
  -- tenant can do.
  permission_codes text[] not null default '{}',

  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_by      uuid references control.platform_users (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint api_keys_prefix_format check (key_prefix ~ '^mtb_(live|test)_[A-Za-z0-9]{8,64}$'),
  -- The prefix must not claim an environment the row does not have.
  constraint api_keys_prefix_matches_environment check (
    key_prefix like 'mtb_' || environment::text || '_%'
  )
);

create trigger api_keys_set_updated_at
  before update on control.api_keys
  for each row execute function control.set_updated_at();

create index api_keys_tenant_id_idx on control.api_keys (tenant_id);
-- Authentication looks up live keys by prefix on every request; keep revoked ones out.
create index api_keys_active_prefix_idx
  on control.api_keys (key_prefix) where revoked_at is null;

comment on column control.api_keys.secret_hash is
  'Argon2 hash of the secret. The plaintext secret is displayed once at creation and is '
  'never stored, logged, or recoverable.';

-- ---------------------------------------------------------------- tenant OAuth2 config

-- Stored here, in the control plane, rather than in the tenant's own schema, so the
-- platform team can audit and rotate it centrally.
create table control.tenant_oauth_configs (
  tenant_id                uuid primary key references control.tenants (id) on delete cascade,

  provider                 text not null,
  client_id                text not null,

  -- Ciphertext only. The API encrypts before writing; the key lives in a vault, never in
  -- this table and never in an environment variable. Keeping the key id
  -- alongside makes rotation possible without guessing which key sealed which row.
  client_secret_ciphertext bytea not null,
  encryption_key_id        text  not null,

  discovery_url            text not null,

  -- A connection test must pass before the config can be activated, so a tenant cannot
  -- lock its own users out with a typo.
  verified_at              timestamptz,
  is_enabled               boolean not null default false,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint tenant_oauth_discovery_is_https check (discovery_url ~ '^https://'),
  constraint tenant_oauth_enabled_requires_verification check (
    is_enabled = false or verified_at is not null
  )
);

create trigger tenant_oauth_configs_set_updated_at
  before update on control.tenant_oauth_configs
  for each row execute function control.set_updated_at();

-- ---------------------------------------------------------------- row level security
--
-- Deny by default, on every table, with force so that not even a table owner reads
-- around it. There are intentionally no policies: the control plane is reached only by
-- the API process using service_role, which bypasses RLS — and precisely because it
-- bypasses RLS, the API does its own authorization check before every query.
--
-- A policy is added here only when a principal other than the API needs a read path, and
-- it comes with the isolation test that proves its bounds.

alter table control.plans                enable row level security;
alter table control.tenants              enable row level security;
alter table control.platform_users       enable row level security;
alter table control.permissions          enable row level security;
alter table control.roles                enable row level security;
alter table control.role_permissions     enable row level security;
alter table control.api_keys             enable row level security;
alter table control.tenant_oauth_configs enable row level security;

alter table control.plans                force row level security;
alter table control.tenants              force row level security;
alter table control.platform_users       force row level security;
alter table control.permissions          force row level security;
alter table control.roles                force row level security;
alter table control.role_permissions     force row level security;
alter table control.api_keys             force row level security;
alter table control.tenant_oauth_configs force row level security;

-- The browser talks to Supabase only for Auth, Realtime and Storage. It must never see
-- the control plane, so the anon and authenticated roles get nothing here at all.
revoke all on schema control from anon, authenticated;
revoke all on all tables in schema control from anon, authenticated;
