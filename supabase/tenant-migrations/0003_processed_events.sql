-- Consumer idempotency (§6, VC-41).
--
-- Delivery is at-least-once: the outbox commits with the change, the queue may hand the
-- same event to a consumer twice after a crash, a retry or a redelivery. That is a
-- property of the transport, not a bug to be fixed there — the fix belongs in the
-- consumer, and this table is it.
--
-- The row is written in the *same transaction* as whatever the consumer did. Writing it
-- afterwards would leave a window where the work committed and the mark did not, which is
-- exactly the crash that produces a second charge, a second message, or a second
-- notification about something already handled.

create table :"schema".processed_events (
  tenant_id    uuid not null,

  consumer     text not null,
  event_id     uuid not null,

  -- Kept for operational forensics: "was this event seen, and when".
  event_type   text not null,
  processed_at timestamptz not null default now(),

  primary key (consumer, event_id),

  constraint processed_events_consumer_shape check (consumer ~ '^[a-z][a-z0-9-]{1,60}$')
);

comment on table :"schema".processed_events is
  'Deduplication ledger: one row per (consumer, event) actually processed (§6, VC-41).';

-- Reading is always by the primary key. This index is for the pruning job: rows older
-- than the queue''s longest retention can go, and nothing else ever scans by time.
create index processed_events_processed_at_idx on :"schema".processed_events (processed_at);

select app.install_tenant_isolation(:'schema', 'processed_events');

-- Equivalent-event suppression (RF-43).
--
-- Distinct from the table above, which answers "did I already handle this exact event".
-- This answers "did I already tell someone this exact thing recently" — the same cash
-- shortfall recomputed hourly is a different event_id every time and the same alert to a
-- human being. Twenty identical warnings in a morning is how people learn to ignore all
-- of them, including the one that mattered.
create table :"schema".suppressed_duplicates (
  tenant_id       uuid not null,

  suppression_key text not null primary key,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  occurrences     integer not null default 1,
  expires_at      timestamptz not null,

  constraint suppressed_duplicates_window_is_future check (expires_at > first_seen_at)
);

comment on table :"schema".suppressed_duplicates is
  'Semantic deduplication window for alerts (RF-43): one row per thing already said.';

create index suppressed_duplicates_expires_at_idx on :"schema".suppressed_duplicates (expires_at);

select app.install_tenant_isolation(:'schema', 'suppressed_duplicates');
