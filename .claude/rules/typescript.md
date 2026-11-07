# TypeScript

## Compiler

`strict: true` in every package, plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`verbatimModuleSyntax`. ESM only (`"type": "module"`). Never lower these settings to
make an error go away.

## Types

- **No `any`.** If truly unavoidable, use `unknown` and narrow, or write
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`.
- No `as` casts to silence the compiler. `as const` and narrowing after a type guard
  are fine; `as unknown as T` is a bug being hidden.
- No non-null assertion `!`. Narrow explicitly, or fail loudly with a typed error.
- Prefer `type` for unions/aliases, `interface` for object contracts meant to be
  implemented or extended.
- Derive, don't duplicate: `Pick`, `Omit`, `ReturnType`, `satisfies`.
- Branded types for identifiers so they can't be swapped:
  ```ts
  type CompanyId = string & { readonly __brand: 'CompanyId' };
  ```
- Discriminated unions over optional-field soup. Model states, not flags.
- `readonly` on properties and `readonly T[]` on arrays that must not mutate.
- Exhaustive switches end with `default: assertNever(value)`.

## Boundaries

Everything entering the process is `unknown` until validated by **Zod**: HTTP bodies,
query params, env vars, webhook payloads, DB rows crossing into domain, `localStorage`,
third-party responses. Infer types from the schema (`z.infer`), never hand-write a type
that duplicates a schema.

## Errors

- Typed error classes with a stable `code`, extending `DomainError` /
  `ApplicationError` / `InfrastructureError`.
- `Result<T, E>` from `shared-kernel` for expected failures (validation, business rule
  violations). Exceptions for genuinely exceptional conditions.
- Never swallow: no empty `catch`, no `catch { return null }`. Handle, wrap with
  context, or let it propagate.
- Catch narrowly: `catch (e: unknown)` then narrow with `instanceof`.
- Never return `null` to mean three different things. `undefined` = absent,
  domain error = rejected.

## Async

- `async/await` only. No `.then()` chains, no mixing.
- No floating promises (`@typescript-eslint/no-floating-promises` is an error). Await it
  or explicitly `void` it with a comment.
- Parallelize independent work with `Promise.all`; use `Promise.allSettled` when partial
  failure is acceptable, and handle each rejection.
- Every outbound call has a timeout and an explicit failure path.
- Never `await` inside a loop over independent items.
