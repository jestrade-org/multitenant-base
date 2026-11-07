-- Audit trail (§8.4).
--
-- This is a business record with a statutory retention of six years, not an operational
-- log. Logs rotate away, are sampled, and live outside the database where nobody can join
-- them to the row they explain. "Who approved this payment" has to be answerable in 2032
-- from the same backup that holds the payment.
--
-- The index lives in the control schema on purpose: an auditor asking "every denied
-- attempt by this accountant" spans tenants, and per-tenant tables would make that query
-- impossible without reaching into every schema — which is exactly the reach that §4.3
-- exists to prevent.

create type control.audit_actor_type as enum (
  'user',
  'api_key',
  'platform_admin',
  'mcp_client'
);

create type control.audit_result as enum ('success', 'denied', 'error');

create table control.audit_events (
  event_id uuid primary key default gen_random_uuid(),

  -- Null only for platform-wide actions that belong to no tenant. The check below keeps
  -- that from becoming a convenient way to file a tenant action under nothing.
  tenant_id uuid references control.tenants (id) on delete restrict,

  actor_type control.audit_actor_type not null,
  actor_id text not null,

  -- English verb codes: 'tenant.suspended', 'authorization.denied'. Stable, because
  -- they are what a compliance query filters on years from now.
  action text not null,
  constraint audit_events_action_shape check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),

  resource_type text,
  resource_id text,

  result control.audit_result not null,

  ip_address inet,
  user_agent text,
  constraint audit_events_user_agent_bounded check (length(user_agent) <= 512),

  -- Server clock, never client-supplied: a timestamp the actor controls is not evidence.
  occurred_at timestamptz not null default now(),
  correlation_id text,

  -- Before/after for mutations. PII-minimised at the call site; this column must never
  -- carry a password, token, or complete business record.
  changes jsonb,

  constraint audit_events_tenant_required_for_tenant_actors check (
    actor_type = 'platform_admin' or tenant_id is not null
  )
);

comment on table control.audit_events is
  'Append-only audit trail (§8.4). Six-year retention. No update or delete from the application.';

-- Every column a compliance query filters on. Audit tables are written far more often
-- than they are read, so the set is deliberately small.
create index audit_events_tenant_occurred_idx
  on control.audit_events (tenant_id, occurred_at desc);
create index audit_events_actor_occurred_idx
  on control.audit_events (actor_type, actor_id, occurred_at desc);
create index audit_events_action_occurred_idx
  on control.audit_events (action, occurred_at desc);
-- Partial: denials are a fraction of the rows and the one thing security review reads.
create index audit_events_denied_idx
  on control.audit_events (tenant_id, occurred_at desc)
  where result = 'denied';
create index audit_events_correlation_idx
  on control.audit_events (correlation_id)
  where correlation_id is not null;

-- Tamper evidence is a grant, not a convention. Application code physically cannot
-- rewrite history, so "the log says it was approved" means something.
alter table control.audit_events enable row level security;
alter table control.audit_events force row level security;
revoke all on control.audit_events from anon, authenticated;

-- Reaching the table needs the schema too. This grants nothing on the *other* control
-- tables: they carry their own `revoke all` and forced RLS with no policies, so schema
-- usage alone opens none of them.
grant usage on schema control to tenant_app;
grant insert, select on control.audit_events to tenant_app;

-- Policies, because forced RLS with none of them denies the insert too — a grant with no
-- policy behind it is decorative. These make the audit row provably belong to the tenant
-- bound on the connection: a request cannot file an event against a company it is not
-- acting for, which is what stops a forged trail from being the cover for a real action.
create policy audit_events_insert_current_tenant on control.audit_events
  for insert to tenant_app
  with check (
    tenant_id = app.current_tenant_id()
    or (actor_type = 'platform_admin' and app.current_tenant_id() is null)
  );

-- Reads are scoped the same way. Cross-tenant compliance analysis is a privileged,
-- itself-audited path (VC-36), not something the application role can do.
create policy audit_events_select_current_tenant on control.audit_events
  for select to tenant_app
  using (tenant_id = app.current_tenant_id());

-- Deliberately no update or delete policy. Three independent things would have to be
-- wrong at once for history to change: the missing grant, the missing policy, the trigger.

-- Belt and braces: the grant above is the control, but a future migration that
-- accidentally widens it should still hit a wall. A trigger fires even for the table
-- owner, which the grant does not.
create or replace function control.reject_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'control.audit_events is append-only (%, event %)', tg_op, old.event_id
    using errcode = 'restrict_violation';
end;
$$;

create trigger audit_events_no_update
  before update on control.audit_events
  for each row execute function control.reject_audit_mutation();

create trigger audit_events_no_delete
  before delete on control.audit_events
  for each row execute function control.reject_audit_mutation();
