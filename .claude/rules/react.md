# React

Applies to: `apps/web/`.

## Structure

```
apps/web/src/
  contexts/<context>/       mirrors the backend bounded contexts
    components/             presentational + container components
    hooks/                  useMembers, useInviteMember
    api/                    typed client for this context's endpoints
    routes/
  shared/                   design system, i18n, providers, layout, utils
```

Colocate by context, never by technical type (`components/` at the root is forbidden).

## Components

- Function components only. No class components, no `React.FC`.
- **Components render; they do not compute business rules.** Anything with a rule in it
  belongs in a domain package behind the API. Formatting and presentation logic only.
- Props are explicit typed objects. No prop spreading except for DOM passthrough on a
  design-system primitive.
- Never pass generated Supabase DB types as props. Use DTOs from the API client.
- Split when a component handles both data fetching and complex rendering: a container
  hook plus a presentational component.
- No hardcoded strings (`t()`), no hardcoded colors, spacing, or font sizes (design tokens).

## State

- **Server state → TanStack Query.** Never in `useState` or a global store.
- **UI state → `useState` / `useReducer`**, as local as possible.
- **Shared cross-page UI state → Context**, one context per concern, split to avoid
  re-renders. No Redux, no Zustand for server data.
- URL is state: filters, pagination, and selected date ranges live in search params so views
  are shareable and reloadable.
- Query keys come from typed factories, never inline string literals:
  ```ts
  export const memberKeys = {
    all: ['members'] as const,
    list: (f: MemberFilters) => [...memberKeys.all, 'list', f] as const,
  };
  ```
- Mutations invalidate explicitly. Optimistic updates only where a rollback is safe —
  **never for money movement**; those wait for server confirmation.

## Data fetching

Every async surface handles **all four states**: loading, empty, error, success.
- Loading: skeletons that match final layout, not a bare spinner.
- Empty: real Spanish copy explaining what to do next, plus an action.
- Error: what failed, how to retry. Never a raw error message or code.
- Stale data is dangerous: set `staleTime` deliberately per query and show
  a "última actualización" timestamp on dashboards.

## Forms

- React Hook Form + Zod resolver. The Zod schema mirrors the API contract; share it via
  a `contracts` package when possible.
- Validation messages come from `t()`.
- Money inputs use a dedicated `MoneyInput` bound to `Money` semantics — never a raw
  `<input type="number">` with a float.
- Disable submit while pending and guard against double submission (idempotency key on
  the request).
- Destructive or irreversible actions (approve, file, pay) need explicit confirmation
  naming the consequence and the amount.

## Rendering & performance

- Stable keys from entity IDs, never array index.
- No derived state in `useEffect`. Compute during render; `useMemo` only when profiling
  shows it matters.
- `useEffect` is for synchronizing with external systems, not for reacting to props.
- Virtualize tables over ~100 rows (`@tanstack/react-virtual`) — audit trails get long.
- Route-level code splitting with `React.lazy` + `Suspense`.
- Memoize (`memo`, `useCallback`) only after measuring.

## Accessibility

- Semantic HTML first; ARIA only when semantics can't express it.
- Every input has an associated `<label>`; errors linked with `aria-describedby`.
- All actions reachable and operable by keyboard; visible focus never removed.
- Data tables use `<caption>`, `<th scope>`, and `<abbr>` for abbreviated units.
- Never encode meaning in color alone — a negative balance needs a sign or icon too.
- Contrast ≥ 4.5:1. Run `axe` in component tests for interactive views.

## Security (client side)

- Never store tokens in `localStorage` — see `@.claude/rules/security-iaaa.md`.
- No `dangerouslySetInnerHTML`. If unavoidable, sanitize with DOMPurify and justify it.
- Never build a URL or redirect from user input without an allowlist.
- The client is not a security boundary: hiding a button is UX, the server still checks.
- No secrets in the bundle. Only `VITE_`-prefixed public values, and audit what they are.
