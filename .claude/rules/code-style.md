# Code Style

## Naming

| Thing                      | Convention              | Example                      |
|----------------------------|-------------------------|------------------------------|
| Directories                | `kebab-case`            | `cash-flow/`                 |
| React components           | `PascalCase.tsx`        | `MemberTable.tsx`            |
| Other TS files             | `camelCase.ts`          | `inviteMember.ts`            |
| Classes, types, interfaces | `PascalCase`            | `RoleRepository`             |
| Variables, functions       | `camelCase`             | `activeMemberCount`          |
| Constants                  | `UPPER_SNAKE_CASE`      | `MAX_RETRY_ATTEMPTS`         |
| DB tables/columns          | `snake_case`, plural    | `tenant_members.full_name`   |
| API payload keys           | `camelCase`             | `{ "companyId": "…" }`       |
| Booleans                   | `is/has/can/should`     | `isActive`, `canManageUsers` |
| Test files                 | `*.test.ts` next to src | `inviteMember.test.ts`       |

- No abbreviations except universal ones (`id`, `url`, `db`). Not `inv`, `usr`, `qty`.
- No Hungarian notation, no `I` prefix on interfaces, no `Impl` suffix — name the
  implementation for what it is: `PostgresRoleRepository`.
- Functions are verbs, classes are nouns, booleans read as predicates.

## Structure

- Named exports. Default exports only where a framework demands one.
- One primary concept per file. If a file needs "and" to describe it, split it.
- No barrel file re-exporting a whole layer. A package exposes one explicit root
  `index.ts` listing its public API.
- Import order: node builtins → external → workspace packages → relative. Enforced by
  `import/order`.
- Max ~200 lines per file, ~40 per function as a smell threshold, not a hard gate.

## Formatting

Prettier decides; never argue about it in review. 2-space indent, single quotes,
semicolons, trailing commas, 100-column print width. `pnpm format` runs on pre-commit.

## Comments

- Explain **why**, not what. The code already says what.
- Document non-obvious domain rules with a source: `// RFC 6265 §4.1.2.5` or the spec section it implements.
- `TODO(username): description` with a linked issue, or don't write it.
- Delete commented-out code. Git remembers.
- Public exports of a package get a TSDoc block.

## Practices

- Guard clauses over nested conditionals. Return early.
- No magic numbers or strings — named constants or value objects.
- Immutability by default: `const`, `readonly`, no mutation of parameters, no
  `array.push` on shared state. Prefer `map`/`filter`/`reduce` when it stays readable.
- No `else` after `return`. No ternary nesting.
- Pure functions where possible; isolate side effects at the edges.
- Dead code is deleted, not commented or `if (false)`-ed.
- Feature flags are read in one place and typed, never `process.env` scattered around.
