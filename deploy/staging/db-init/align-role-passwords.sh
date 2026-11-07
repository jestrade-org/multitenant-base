#!/bin/sh
# Runs once, only on a fresh data volume (standard docker-entrypoint-initdb.d
# behavior). supabase/postgres creates supabase_auth_admin (and the other Supabase
# roles) with its own baked-in default password, not $POSTGRES_PASSWORD — without
# this, GoTrue's own migrations fail SASL auth against a password it never had.
set -eu

psql -v ON_ERROR_STOP=1 --username supabase_admin --dbname postgres <<-EOSQL
  ALTER ROLE supabase_auth_admin WITH PASSWORD '${POSTGRES_PASSWORD}';
EOSQL
