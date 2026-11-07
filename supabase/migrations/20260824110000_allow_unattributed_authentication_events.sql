-- Authentication events happen before a tenant is known.
--
-- A sign-in attempt with an address that belongs to nobody is precisely the event worth
-- recording — it is what a credential-stuffing run looks like — and it has no tenant to
-- file itself under. The original constraint required one for every non-platform actor,
-- which made the most security-relevant event the one event that could not be written.
--
-- Widened rather than removed: a tenant-scoped action still cannot be filed under nothing.

alter table control.audit_events
  drop constraint audit_events_tenant_required_for_tenant_actors;

alter table control.audit_events
  add constraint audit_events_tenant_required_for_tenant_actors check (
    tenant_id is not null
    or actor_type = 'platform_admin'
    -- Only the authentication namespace, so this stays a narrow exception rather than a
    -- way for any action to opt out of being attributable to a company.
    or action like 'authentication.%'
  );

-- The insert policy has to allow the same case, or the constraint is decorative.
drop policy audit_events_insert_current_tenant on control.audit_events;

create policy audit_events_insert_current_tenant on control.audit_events
  for insert to tenant_app
  with check (
    tenant_id = app.current_tenant_id()
    or (actor_type = 'platform_admin' and app.current_tenant_id() is null)
    or (tenant_id is null and action like 'authentication.%')
  );

-- Failed sign-ins are read by security review, not by a tenant, and they carry no
-- tenant_id — so the tenant-scoped select policy would hide them from everyone. They are
-- reachable through the compliance path (VC-36), which is itself audited.
create index audit_events_authentication_idx
  on control.audit_events (occurred_at desc)
  where action like 'authentication.%';
