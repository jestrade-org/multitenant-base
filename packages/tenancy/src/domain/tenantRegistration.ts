import { DomainError, ValidationError } from '@multitenant-base/shared-kernel';

/**
 * Registering a new company (tenant).
 *
 * The values here reach SQL as identifiers — a schema name is interpolated into `create
 * schema`, and no amount of care downstream can rescue a bad one. So they are derived here,
 * from a rule, and validated against the same shape the database constrains. A subdomain
 * the operator typed is *checked*, never trusted.
 */

export class TenantAlreadyRegisteredError extends DomainError {
  public override readonly name = 'TenantAlreadyRegisteredError';
  public readonly code = 'TENANT_ALREADY_REGISTERED';

  public constructor(
    public readonly field: 'tax_id' | 'subdomain',
    public readonly value: string,
  ) {
    super(`A tenant with this ${field} already exists`, { field, value });
  }
}

const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{1,60}$/;

/**
 * A company's tax or legal registration number, in whatever country it is registered.
 *
 * Deliberately format-agnostic: a base meant for many projects cannot know whether it is
 * holding an EIN, a VAT number, a CNPJ or a NIT. It is normalised (uppercased, separators
 * and spaces removed) so the same number typed two ways is recognised as one company. A
 * project that serves a single jurisdiction should replace this with a value object that
 * validates that jurisdiction's check digit.
 */
const TAX_ID = /^[A-Z0-9]{3,30}$/;

export function normalizeTaxId(raw: string): string {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[\s.\-/]/g, '');
  if (!TAX_ID.test(normalized)) {
    throw new ValidationError(
      'taxId',
      'a tax identifier is 3 to 30 letters or digits, optionally separated by dots, dashes or slashes',
    );
  }
  return normalized;
}
const SCHEMA_SUFFIX = /^[a-z0-9_]{1,40}$/;

/**
 * The real ceiling on a subdomain, which is not the subdomain's own limit.
 *
 * A hostname label allows 63 characters, but the schema name derived from it allows 40 plus
 * the `tenant_` prefix. Generating against the looser of the two produced a perfectly valid
 * subdomain that could not become a schema — found on the first real company name tried,
 * "Servicios Portuarios Marítimos y Terrestres de la Costa S.A.S", which derives to 47
 * characters.
 */
const MAX_SUBDOMAIN_LENGTH = 40;

/**
 * Reserved subdomains.
 *
 * A company called "API Inc." would otherwise be provisioned at `api.example.test`, which
 * collides with our own hostname and, more quietly, makes the tenant resolver read a
 * request for the API as a request for that client.
 */
const RESERVED = new Set([
  'api',
  'www',
  'admin',
  'app',
  'staging',
  'mail',
  'status',
  'docs',
  'panel',
  'platform',
  'plataforma',
]);

export interface TenantRegistration {
  readonly name: string;
  readonly taxId: string;
  readonly subdomain: string;
  readonly schemaName: string;
  readonly timezone: string;
  readonly planCode: string;
}

export interface RegisterTenantInput {
  readonly name: string;
  /** As the operator typed it — `12-3456789`, `B12345678`, `900.123.456-8`. */
  readonly taxId: string;
  /** Optional: derived from the name when absent, which is what usually happens. */
  readonly subdomain?: string;
  readonly timezone?: string;
  readonly planCode: string;
}

export function prepareTenantRegistration(input: RegisterTenantInput): TenantRegistration {
  const name = input.name.trim();
  if (name.length < 2) {
    throw new ValidationError('name', 'a client needs a name a person can recognise');
  }

  // Normalised, not stored as typed, so the same company typed twice is caught as a
  // duplicate rather than registered as two tenants.
  const taxId = normalizeTaxId(input.taxId);

  const subdomain = (input.subdomain ?? suggestSubdomain(name)).trim().toLowerCase();
  if (!SUBDOMAIN.test(subdomain)) {
    throw new ValidationError(
      'subdomain',
      'must be lowercase letters, digits and hyphens, starting with a letter or digit',
    );
  }
  if (RESERVED.has(subdomain)) {
    throw new ValidationError('subdomain', `"${subdomain}" is reserved`);
  }

  // The schema name is derived from the subdomain rather than accepted separately: two
  // fields that must agree are two fields that will one day disagree.
  const suffix = subdomain.replace(/-/g, '_');
  if (!SCHEMA_SUFFIX.test(suffix)) {
    // Says which limit and by how much: an operator shortening a name by guesswork will
    // try three times.
    throw new ValidationError(
      'subdomain',
      `"${subdomain}" is ${String(subdomain.length)} characters; a schema name allows ` +
        `${String(MAX_SUBDOMAIN_LENGTH)}. Choose a shorter subdomain`,
    );
  }

  return {
    name,
    taxId,
    subdomain,
    schemaName: `tenant_${suffix}`,
    // UTC unless the operator says otherwise, and stated rather than assumed: day and
    // month boundaries for the company are computed in it.
    timezone: input.timezone ?? 'UTC',
    planCode: input.planCode,
  };
}

/**
 * A subdomain from a company name.
 *
 * Strips common legal forms (Inc., LLC, Ltd., S.A., S.A.S., GmbH…) — including them would
 * make every subdomain end the same way and none of them shorter than the name.
 */
export function suggestSubdomain(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(
        /\b(inc\.?|llc|ltd\.?|corp\.?|co\.?|gmbh|s\.?a\.?s\.?|ltda\.?|s\.?a\.?|s\.?l\.?|e\.?u\.?|cia\.?|and|of|the|y|de|del|la|el)\b/g,
        ' ',
      )
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SUBDOMAIN_LENGTH)
      // Slicing can leave a trailing hyphen, which is not a legal hostname label ending.
      .replace(/-+$/, '')
  );
}
