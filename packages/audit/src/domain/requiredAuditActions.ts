/**
 * The audit events §8.4 requires, as data (VC-35).
 *
 * A prose list in a specification is a list somebody forgets. This one is checked by
 * `tools/required-audit-actions.test.ts`: an action marked implemented whose code appears
 * nowhere fails the build, and an action still pending must name the ticket that will
 * produce it. The day that ticket lands, the entry has to be flipped — and flipping it
 * without writing the event fails too.
 *
 * That is the whole point. "We will remember to audit it" is not a control; a failing
 * build is.
 */

export interface RequiredAuditAction {
  /** The `action` value the row carries. Stable, English, dot-namespaced. */
  readonly action: string;
  /** What §8.4 calls it, so the mapping to the specification is visible. */
  readonly requirement: string;
  /**
   * The ticket that will produce it, when nothing does yet.
   *
   * Absent means the event is written today and the test proves the code exists. Present
   * means the feature does not exist — which is honest, and visible, and time-bound to a
   * ticket rather than to somebody's memory.
   */
  readonly pendingTicket?: string;
}

export const REQUIRED_AUDIT_ACTIONS: readonly RequiredAuditAction[] = [
  {
    action: 'authentication.signed_in',
    requirement: 'successful sign-ins',
  },
  {
    action: 'authentication.sign_in_failed',
    requirement: 'failed sign-ins',
  },
  {
    action: 'authentication.signed_out',
    requirement: 'sign-outs',
  },
  {
    action: 'iam.role_created',
    requirement: 'role and permission changes',
  },
  {
    action: 'iam.role_redefined',
    requirement: 'role and permission changes',
  },
  {
    action: 'iam.role_deleted',
    requirement: 'role and permission changes',
  },
  {
    action: 'iam.member_invited',
    requirement: 'role and permission changes',
  },
  {
    action: 'iam.member_role_changed',
    requirement: 'role and permission changes',
  },
  {
    action: 'iam.member_deactivated',
    requirement: 'role and permission changes',
  },
  {
    action: 'iam.member_reactivated',
    requirement: 'role and permission changes',
  },
  {
    action: 'tenant.provisioned',
    requirement: 'administrative changes to a company',
  },
  {
    action: 'tenant.suspended',
    requirement: 'administrative changes to a company',
  },
  {
    action: 'tenant.resumed',
    requirement: 'administrative changes to a company',
  },
  {
    action: 'tenant.plan_changed',
    requirement: 'administrative changes to a company',
  },
  {
    action: 'platform.plan_created',
    requirement: 'administrative changes to what a company is sold and limited to',
  },
  {
    action: 'platform.plan_redefined',
    requirement: 'administrative changes to what a company is sold and limited to',
  },
  {
    action: 'platform.job_replayed',
    requirement: 'an administrative override: re-running work on a company\u2019s account',
  },
  {
    action: 'platform.job_discarded',
    requirement: 'an administrative override: deciding a company\u2019s job will never run',
  },
  {
    // The cross-tenant audit query is the one read that can see every client at once, so
    // the read itself is an audited event (§8.4, VC-75).
    action: 'audit.searched',
    requirement: 'consultation of the cross-tenant audit index',
  },
  {
    action: 'api_key.created',
    requirement: 'creation of API keys',
  },
  {
    action: 'api_key.rotated',
    requirement: 'rotation of API keys',
  },
  {
    action: 'api_key.revoked',
    requirement: 'revocation of API keys',
  },
  {
    action: 'authorization.denied',
    requirement: 'every authorization denial',
  },
  {
    action: 'authorization.granted',
    requirement: 'every authorization decision',
  },
  {
    action: 'platform.support_access_granted',
    requirement: 'platform staff reaching into a company (§8.1)',
  },
  {
    // The end of a support session is as much a fact as its start: a trail that records
    // only the opening cannot answer how long someone was inside a client's account.
    action: 'platform.support_access_ended',
    requirement: 'platform staff leaving a company (§8.1)',
  },
];

/** The actions a working system writes today. */
export function implementedAuditActions(): readonly string[] {
  return REQUIRED_AUDIT_ACTIONS.filter((entry) => entry.pendingTicket === undefined).map(
    (entry) => entry.action,
  );
}

/** The actions §8.4 requires that nothing produces yet, with the ticket that will. */
export function pendingAuditActions(): readonly RequiredAuditAction[] {
  return REQUIRED_AUDIT_ACTIONS.filter((entry) => entry.pendingTicket !== undefined);
}
