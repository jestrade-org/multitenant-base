# Language & Internationalization

**The codebase is in English. The product UI is in Spanish. No exceptions.**

## English — always

Identifiers (variables, functions, classes, types, enums), file and folder names,
database tables/columns/enums/functions, API routes and payload keys, comments, commit
messages, PR titles and descriptions, test names, log messages, error codes, branch
names, environment variables, ADRs and `/docs`.

## Spanish — only here

Strings an end user reads. They live exclusively in translation files, never inline.

```ts
// ✅
const member = await memberDirectory.findById(memberId, companyId);
if (!member.isActive) throw new MemberInactiveError(member.id);
<span>{t('members.status.inactive')}</span>

// ❌
const miembro = await directorioMiembros.buscarPorId(idMiembro, idEmpresa);
<span>Usuario inactivo</span>
throw new Error('El usuario está inactivo');
// verifica si el usuario está activo   ← comment in Spanish
```

## Domain vocabulary

A project built on this base may have legal or regulatory terms with no clean English
equivalent (a tax identifier, an authority, a form). Those stay in their original language
as **proper nouns**, documented the first time they appear in a module, rather than being
given an invented English translation:

```ts
/** CUIT: Argentine taxpayer identifier, including its check digit.
 *  Kept untranslated — it is a legal identifier. */
export class Cuit extends ValueObject<string> {}
```

Record such terms in the project's glossary (`docs/glossary-es.md`).

## Mechanics

- All user-facing copy goes through `t()` (`react-i18next`).
- Locales: `apps/web/src/shared/i18n/locales/es/<namespace>.json`.
- Keys are **English**, dot-namespaced, and describe *meaning*, not text:
  `members.list.emptyState` — not `members.list.noHayUsuarios`, not `text1`.
- Never concatenate translated fragments. Use interpolation and i18next plural keys:
  ```json
  { "memberCount_one": "{{count}} usuario",
    "memberCount_other": "{{count}} usuarios" }
  ```
- A missing key must fail loudly in dev and CI (`saveMissing: false`,
  `missingKeyHandler` throws in test).
- Copy review: Spanish uses formal *usted* and consistent terminology (`empresa`, not
  sometimes `cliente`; `usuario`, not sometimes `miembro` in the same screen). Keep a
  glossary in `docs/glossary-es.md`.

## Server → client messages

The API returns a **stable English code plus parameters**. The client maps the code to
Spanish. Spanish text never crosses the wire.

```jsonc
// API response
{ "error": { "code": "MEMBER_ALREADY_INVITED", "params": { "email": "ana@acme.test" } } }
```
```jsonc
// es/admin.json
{ "MEMBER_ALREADY_INVITED": "Ese correo ya pertenece a un usuario de su empresa." }
```

An unmapped code renders a generic message and logs a warning — never the raw code.

## Formatting

Format at the edge with `Intl`, never by hand.

- Numbers/currency: `Intl.NumberFormat('es', { style: 'currency', currency })`. A project
  serving one country narrows the locale (`es-CO`, `es-MX`, `es-ES`) in
  `shared/i18n/format.ts`, in one place.
- Dates: `Intl.DateTimeFormat('es')`. Store `timestamptz` in UTC, render in the company's
  timezone (stored on the tenant), never the browser's. Platform screens, which belong to
  no company, render in UTC.
- Never hardcode `,` / `.` separators or `DD/MM/YYYY` patterns.
