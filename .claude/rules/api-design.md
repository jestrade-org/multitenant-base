# API Design

Applies to: `apps/api/`.

## Contract

- REST over HTTPS, JSON only. Resource-oriented paths, plural nouns:
  `POST /api/v1/companies/{companyId}/projects`.
- Verbs live in the HTTP method, not the path. Exception: explicit domain actions
  modelled as sub-resources — `POST /tenants/{id}/suspend`, `POST /keys/{id}/rotate`.
- Versioned prefix `/api/v1`. Breaking changes require a new version and a deprecation
  window, announced with `Sunset` headers.
- Payload keys are `camelCase` English. Mappers translate from `snake_case` DB rows.
- Dates are ISO-8601 with offset. Money is `{ "amount": "1234.5600", "currency": "USD" }`
  — **a string, never a JSON number** (float precision loss in JS).

## Handlers

Routes are thin: **validate input → resolve use case → map result to HTTP**. Zero
business logic, zero SQL, zero conditionals about domain state in a handler.

```ts
app.post('/members', async (request, reply) => {
  const command = inviteMemberSchema.parse(request.body);
  const result = await inviteMember.execute({ ...command, actor: request.actor });
  return reply.code(201).send(toMemberResponse(result));
});
```

## Validation

- Every input is validated at the boundary with Zod: body, params, query, headers.
- Reject unknown fields (`.strict()`) — silent acceptance hides client bugs and
  mass-assignment attacks.
- Never trust `req.body` for identity, company, role, price, or totals. Those are
  derived server-side from the token and the database.
- Bound everything: string lengths, array sizes, page size (default 25, max 100),
  request body size, date ranges on reports.

## Responses

| Situation                    | Status |
|------------------------------|--------|
| Read / update success        | 200    |
| Resource created             | 201 (+ `Location`) |
| Accepted async job           | 202    |
| Success, no body             | 204    |
| Validation failure           | 400    |
| Missing/invalid credentials  | 401    |
| Authenticated but not allowed| 403    |
| Not found **or** not visible to this tenant | 404 |
| Business rule violation      | 409    |
| Rate limited                 | 429    |
| Unexpected                   | 500    |

Return **404, not 403**, for another tenant's resource — a 403 confirms it exists.

## Errors

One central mapper translates domain error codes to HTTP. Shape:

```jsonc
{
  "error": {
    "code": "MEMBER_ALREADY_INVITED",   // stable, English, documented
    "params": { "memberId": "8f3…" },   // for client-side interpolation
    "correlationId": "01HRZ…"           // matches the server log
  }
}
```

- Never leak stack traces, SQL, driver messages, internal paths, or dependency names.
- Never return Spanish text — the client maps codes. See `@.claude/rules/language-i18n.md`.
- Validation errors list field paths, not a concatenated message blob.
- Unknown exceptions become a generic 500 with a correlation ID, logged in full.

## Idempotency & concurrency

- Every state-changing endpoint that a user could double-submit accepts an
  `Idempotency-Key` header, stored with the result and replayed on retry.
- Updates to editable aggregates use `If-Match`/`version` and return 409 on conflict.
  Never last-write-wins on business records.

## Cross-cutting

- Rate limits per user **and** per IP, stricter on auth and report-generation endpoints.
- CORS: explicit origin allowlist, credentials only for known origins. Never `*`.
- Security headers via Helmet; HSTS in production.
- Pagination metadata is consistent: `{ items, nextCursor, totalCount? }`.
- Long operations (report generation, bulk import, external submissions) return `202` with a job
  resource to poll. Never hold a request open for minutes.
- Every endpoint is documented in an OpenAPI spec generated from the Zod schemas —
  the spec is derived, not maintained by hand.
