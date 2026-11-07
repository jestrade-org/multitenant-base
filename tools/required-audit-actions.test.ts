import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  implementedAuditActions,
  pendingAuditActions,
  REQUIRED_AUDIT_ACTIONS,
} from '../packages/audit/src/domain/requiredAuditActions.js';

/**
 * Every audit event §8.4 requires is either written or owed to a ticket (VC-35).
 *
 * The failure this prevents is not a bug — it is a silence. A feature ships, nobody writes
 * its audit event, every test passes, and the gap is discovered by an auditor asking who
 * approved something a year ago. Nothing else in the suite would notice.
 *
 * So the check is deliberately crude and hard to fool: the action code must appear as a
 * literal in the source. Grepping is a weak proof that the event is written *correctly* —
 * the integration tests do that for the paths they cover — but it is a strong proof that
 * somebody at least wrote the code, which is exactly what gets forgotten.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where an action code may legitimately appear as the thing that writes it. */
function occursInSource(action: string): boolean {
  try {
    const found = execFileSync(
      'git',
      [
        'grep',
        '--fixed-strings',
        '--files-with-matches',
        // Untracked files count. Without this the check answers "nobody wrote it" for code
        // that is written and simply not staged yet — so a developer running the suite is
        // told their new audit event is missing while it sits open in their editor. CI is
        // unaffected either way; the local answer is the one that was wrong.
        '--untracked',
        `'${action}'`,
        '--',
        'apps',
        'packages',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );

    // The registry itself lists every action, so it never counts as a producer.
    return found
      .split('\n')
      .filter((file) => file.trim() !== '')
      .some((file) => !file.endsWith('requiredAuditActions.ts'));
  } catch {
    // git grep exits non-zero when there are no matches.
    return false;
  }
}

describe('the audit events §8.4 requires', () => {
  it.each(implementedAuditActions().map((action) => [action]))('something writes %s', (action) => {
    expect(occursInSource(action)).toBe(true);
  });

  it.each(pendingAuditActions().map((entry) => [entry.action, entry.pendingTicket ?? '']))(
    '%s is owed to %s and is not silently written elsewhere',
    (action) => {
      // The mirror check. An action marked pending that *is* written means the registry is
      // stale, and a stale registry is worse than none: it reports work as outstanding
      // that is done, and hides the ones that are not.
      expect(occursInSource(action)).toBe(false);
    },
  );

  it('names a ticket for everything still owed', () => {
    for (const entry of pendingAuditActions()) {
      expect(entry.pendingTicket).toMatch(/^[A-Z][A-Z0-9]*-\d+$/);
    }
  });

  it('lists no action twice', () => {
    const actions = REQUIRED_AUDIT_ACTIONS.map((entry) => entry.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('has every action in the shape the trail stores', () => {
    // `context.verb`, lower case. The column is indexed and queried by prefix, so a stray
    // capital makes an event invisible to the query that looks for its family.
    for (const entry of REQUIRED_AUDIT_ACTIONS) {
      expect(entry.action).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});
