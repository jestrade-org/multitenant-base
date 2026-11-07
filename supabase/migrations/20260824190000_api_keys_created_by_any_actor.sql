-- API keys are created by a client's own administrator, not only by platform staff.
--
-- `api_keys.created_by` referenced `control.platform_users(id)`, which encoded an
-- assumption the product does not hold: §9 gives the tenant administrator API key
-- management, and their identity lives in `auth.users` via `control.tenant_members` — not
-- in the platform roster. Every attempt by a client to mint a key failed on the foreign
-- key with a 500.
--
-- The column keeps recording who did it and loses the constraint rather than pointing at
-- a second table: a person can be a member of more than one company, so `auth_user_id` is
-- not unique in `tenant_members` and cannot be referenced. The authoritative record of who
-- created a key is the audit event, which is append-only and outlives both tables.
alter table control.api_keys
  drop constraint if exists api_keys_created_by_fkey;

comment on column control.api_keys.created_by is
  'The auth user who created the key. Not a foreign key: the same person can belong to '
  'several companies, and the audit trail is the authoritative record of the act.';
