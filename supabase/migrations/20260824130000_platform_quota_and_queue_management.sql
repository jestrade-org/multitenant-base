-- The platform panel's remaining surfaces.
--
-- Two things land here, and they are both about letting platform staff operate the product
-- without gaining a read path into any company's data:
--
--   1. `platform:queue_manage` — the capability to *act* on a job, as distinct from the
--      existing `platform:queue_monitor`, which only reads.
--   2. `control.tenant_quota_usage` — a snapshot of what each client is using, so the
--      quota screen serves a few integers per tenant instead of fanning out a query
--      across every client's schema on every page view.

-- ---------------------------------------------------------------- queue management
--
-- `platform:queue_monitor` is already held by the platform operator, whose job is watching
-- the queues. Replaying a dead-lettered job is a different act: a `notifications` job put
-- back on the queue sends a real message to a real person. Splitting the two is the
-- difference between an operator who can see a failure and one who can cause someone to
-- be contacted twice.

insert into control.permissions (code, context, description) values
  ('platform:queue_manage', 'tenancy',
   'Replay or discard a dead-lettered job. Distinct from queue_monitor, which only reads');

insert into control.role_permissions (role_id, permission_code)
select r.id, 'platform:queue_manage'
  from control.roles r
 where r.tenant_id is null and r.code = 'platform_admin';

-- ---------------------------------------------------------------- quota usage
--
-- One row per tenant, overwritten by each verification pass. Not append-only: this is an
-- operational measurement, not a business record — the *events* it raises are what the
-- audit trail keeps, and those are already immutable in control.audit_events.

create table control.tenant_quota_usage (
  tenant_id uuid primary key references control.tenants (id) on delete cascade,

  -- Counts, and only counts. There is deliberately nowhere in this table to put a record:
  -- the platform panel reads it, and the platform panel holds no company data. A project
  -- adds a column here for each quota it adds to control.plans.
  users           integer not null,

  -- The worst status the client was last *told* about, so QuotaThresholdReached fires on
  -- the crossing rather than on every daily pass. A client warned every morning that they
  -- are at 91% stops reading the alert, and then misses the one that says 100%.
  notified_status text not null,

  -- As-of. A quota figure with no date is a figure nobody can act on, so the screen shows
  -- this and the column is not nullable.
  measured_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_quota_usage_counts_not_negative check (users >= 0),
  constraint tenant_quota_usage_status_known check (
    notified_status in ('within', 'warning', 'exceeded')
  )
);

create trigger tenant_quota_usage_set_updated_at
  before update on control.tenant_quota_usage
  for each row execute function control.set_updated_at();

-- The panel's query: everyone against a limit, worst first. Partial, because the rows
-- that matter are a small fraction of the table and stay so as clients are added.
create index tenant_quota_usage_strained_idx
  on control.tenant_quota_usage (measured_at desc)
  where notified_status <> 'within';

comment on table control.tenant_quota_usage is
  'Latest measured plan usage per tenant. Counts only — never records. '
  'Refreshed by the plan-quota-verification job.';

-- Deny by default, like every other control-plane table. Reached only by the API using
-- service_role, which bypasses RLS — and precisely because it bypasses RLS, the API
-- checks `platform:plan_manage` in the use case before every read (§8.3).
alter table control.tenant_quota_usage enable row level security;
alter table control.tenant_quota_usage force row level security;
revoke all on control.tenant_quota_usage from anon, authenticated;
