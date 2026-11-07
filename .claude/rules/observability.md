# Observability

## Logging

- Structured JSON only (pino). No `console.log` in application code — it fails lint.
- Levels used consistently: `error` (needs a human), `warn` (degraded, self-recovering),
  `info` (business milestones), `debug` (development only, off in production).
- Every log line carries: `correlationId`, `companyId`, `actorId`, `context` (bounded
  context), `action`. Bind them once per request; don't repeat them by hand.
- Log messages are **English**, static strings with structured fields — never
  interpolated prose. `logger.info({ memberId, roleCode }, 'member invited')`, not
  `` logger.info(`invited member ${id}`) ``. Interpolated messages are unaggregatable.
- **Never log:** passwords, tokens, session IDs, API keys, full government or tax
  identifiers, bank account numbers, or complete business records. Log identifiers instead.
- Mask unavoidable PII at the logger level with a redaction config, so a careless call
  site cannot leak it.
- Log errors once, at the boundary that handles them. Rethrowing plus logging at every
  level produces noise, not insight.
- Retention and access to logs are themselves controlled — logs contain business data.

## Correlation

- A `correlationId` (ULID) is generated at the edge or taken from an inbound header,
  propagated through use cases, background jobs, and outbound calls.
- The client shows it on error screens so a user can quote it in support.
- It appears in the API error response, the log line, and the trace. One ID joins them.

## Metrics

Track and alert on:
- **RED per endpoint:** rate, errors, duration (p50/p95/p99).
- **Business:** companies provisioned, members invited, quota thresholds crossed, and
  each project's own milestones; failed integrations with third parties.
- **Correctness:** reconciliation drift, quota snapshots that disagree with their source,
  outbox events stuck unpublished. These page someone — they are correctness failures, not noise.
- **Security:** authentication failures, authorization denials, rate-limit trips,
  unusual export volume.
- **Resources:** DB connection pool saturation, slow-query count, queue depth and age,
  event-loop lag.

Metric names are English, `snake_case`, with units in the name
(`tenant_provision_duration_ms`). Labels are bounded — never a user ID or tenant ID as a
label (cardinality explosion).

## Tracing

- OpenTelemetry spans across the API, use cases, and database calls.
- Span names describe the operation (`ProvisionTenant`, `RoleRepository.save`), with
  attributes for context and tenant — never PII in attributes.
- Sample aggressively for normal traffic; always sample errors and money movement.

## Errors

- Unhandled exceptions go to an error tracker (Sentry) with the correlation ID, release
  version, and user/company **IDs only** — PII scrubbing enabled in the SDK.
- Source maps uploaded at build time and **not** served publicly.
- Every alert has an owner and a runbook link. An alert with no action is deleted or
  demoted — alert fatigue kills incident response.

## Health & SLOs

- `/health/live` (process) and `/health/ready` (dependencies actually checked).
- Define SLOs for the flows that matter: sign-in, company provisioning, report
  generation. Track error budget; a burned budget stops feature work.
- Every deployment is annotated in the dashboards so regressions are attributable.

## Auditing vs logging

Logs are operational and transient. The **audit trail** is a business record with legal
retention, lives in Postgres, and is append-only. Never rely on logs for audit —
see `@.claude/rules/security-iaaa.md` §4.
