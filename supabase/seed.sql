-- Local and staging fixtures.
--
-- Two synthetic companies, because a single-tenant environment cannot demonstrate
-- isolation, and the cross-tenant leak tests need a second company to try to reach.
--
-- Synthetic data only. Never real customer data, in any environment.

insert into control.plans (code, name, monthly_price, currency, max_users) values
  ('starter',    'Starter',     49.0000, 'USD',  5),
  ('business',   'Business',   149.0000, 'USD', 15),
  ('enterprise', 'Enterprise', 399.0000, 'USD', 40);

-- Two companies sharing one database, which is exactly the pairing the isolation rules
-- exist for: a leak between these two is the worst case for the product.
insert into control.tenants (name, tax_id, plan_id, lifecycle_status, schema_name, subdomain, timezone, provisioned_at)
select 'Acme Logistics Inc.', '123456789', p.id, 'active',
       'tenant_acme', 'acme', 'America/New_York', now()
from control.plans p where p.code = 'business';

insert into control.tenants (name, tax_id, plan_id, lifecycle_status, schema_name, subdomain, timezone, provisioned_at)
select 'Globex Corporation', '987654321', p.id, 'onboarding',
       'tenant_globex', 'globex', 'Europe/Madrid', now()
from control.plans p where p.code = 'starter';

-- Demo users for the local stack, so the login screen has someone to sign in as.
-- Created through the Auth admin API by `pnpm seed:auth`, not here: passwords are hashed
-- by the auth provider and must never be written by hand into a seed file.
