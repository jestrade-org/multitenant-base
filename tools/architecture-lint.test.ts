import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The dependency rule is only a defence if it actually fires. A lint rule that was
 * configured but never proven to catch anything is worse than no rule at all: it buys
 * false confidence. These fixtures are deliberate violations, and this test fails the
 * build if the architecture lint stops reporting any one of them.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtures = fileURLToPath(new URL('./architecture-fixtures', import.meta.url));

interface EslintMessage {
  readonly ruleId: string | null;
  readonly message: string;
}
interface EslintResult {
  readonly filePath: string;
  readonly messages: readonly EslintMessage[];
}

function lintFixtures(): readonly EslintResult[] {
  try {
    execFileSync(
      'node',
      [
        `${repoRoot}node_modules/eslint/bin/eslint.js`,
        '--config',
        `${repoRoot}eslint.architecture.config.js`,
        '--format',
        'json',
        '.',
      ],
      // The zones in the architecture config are resolved against the working
      // directory, so the fixtures must be linted from their own root for
      // `./packages/*/src/domain/**` to mean what it means in the real repo.
      { cwd: fixtures, encoding: 'utf8' },
    );
  } catch (error: unknown) {
    // ESLint exits non-zero precisely because the fixtures violate the rules.
    const stdout = (error as { stdout?: string }).stdout ?? '';
    return JSON.parse(stdout) as readonly EslintResult[];
  }
  throw new Error(
    'The architecture lint reported no problems on the violation fixtures. ' +
      'The dependency rule is no longer being enforced.',
  );
}

const results = lintFixtures();

function rulesReportedFor(fileSuffix: string): readonly string[] {
  const result = results.find((r) => r.filePath.endsWith(fileSuffix));
  if (!result) throw new Error(`No lint result for fixture ${fileSuffix}`);
  return result.messages.map((m) => m.ruleId ?? 'unknown');
}

describe('architecture lint', () => {
  it('rejects a domain file importing its own infrastructure layer', () => {
    expect(rulesReportedFor('domain/imports-infrastructure.ts')).toContain(
      'import/no-restricted-paths',
    );
  });

  it('rejects a domain file importing a framework package', () => {
    expect(rulesReportedFor('domain/imports-framework.ts')).toContain('no-restricted-imports');
  });

  it('rejects a domain file reading the system clock or a random source', () => {
    const rules = rulesReportedFor('domain/reads-the-clock.ts');
    expect(rules.filter((r) => r === 'no-restricted-properties')).toHaveLength(2);
    expect(rules).toContain('no-restricted-syntax');
  });

  it('rejects an application file importing the infrastructure layer', () => {
    expect(rulesReportedFor('application/imports-infrastructure.ts')).toContain(
      'import/no-restricted-paths',
    );
  });

  it('rejects reaching into another context past its public index', () => {
    expect(rulesReportedFor('application/deep-imports-a-context.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('rejects SQL that names a tenant schema by hand', () => {
    expect(rulesReportedFor('application/names-a-tenant-schema.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  it('rejects interpolating a schema into SQL, and reaching for search_path', () => {
    const rules = rulesReportedFor('application/interpolates-a-schema.ts');
    expect(rules.filter((r) => r === 'no-restricted-syntax').length).toBeGreaterThanOrEqual(2);
  });

  it('leaves a legitimate infrastructure file alone', () => {
    const clean = results.find((r) => r.filePath.endsWith('infrastructure/adapter.ts'));
    expect(clean?.messages ?? []).toHaveLength(0);
  });
});
