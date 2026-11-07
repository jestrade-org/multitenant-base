import {
  authorizedUseCase,
  openToEveryMember,
  permission,
  requireAll,
  ValidationError,
  type Actor,
  type AuthorizedUseCase,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

/**
 * Support access: platform staff acting inside a client's account (§8.1, VC-101).
 *
 * ## What this is, and what it deliberately is not
 *
 * It is *not* a login as the client's user. Nothing here issues a credential for them, and
 * the staff member's own token remains the only one in play. What a grant does is tell the
 * API to resolve that staff member's requests as one member of one company, for a bounded
 * period, until they hand it back.
 *
 * The difference matters beyond implementation tidiness. §8.1 requires every action to be
 * attributable to one human; a feature that minted the client's credentials would make
 * support activity indistinguishable from the client's own in a record kept for six years.
 * Here the actor is always the staff member — the tenant and the role come from the grant,
 * the identity does not — so the trail answers "who did this" with a name, every time.
 *
 * ## Why it expires, and why the reason is required
 *
 * A grant with no end is a standing key to a company's books. A grant with no stated reason
 * is indistinguishable from a mis-click when someone reads it back a year later, which is
 * exactly when it will be read. Both are refusals here rather than conventions.
 */

const SUPPORT_ACCESS = permission('platform:support_access');

/** A person a grant could be opened against. Identifiers and names; no business data. */
export interface TenantMemberDto {
  readonly memberId: string;
  readonly fullName: string;
  readonly email: string;
  readonly roleCode: string;
  readonly tenantId: string;
  readonly tenantName: string;
}

export interface SupportAccessGrantDto {
  readonly grantId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly memberEmail: string;
  readonly roleCode: string;
  /** ISO-8601. The interface counts down to it and the API stops honouring it at it. */
  readonly expiresAt: string;
}

export interface EndedGrantDto {
  readonly grantId: string;
  readonly tenantId: string;
  readonly memberId: string;
}

export interface SupportAccessDirectory {
  searchMembers(input: {
    readonly query: string | undefined;
    /** Narrows to one client. The platform panel lists a company's people this way. */
    readonly tenantId: string | undefined;
    readonly limit: number;
  }): Promise<readonly TenantMemberDto[]>;

  /** Opens a grant. `undefined` when the member id names nobody who can still be reached. */
  open(input: {
    readonly staffAuthUserId: string;
    readonly memberId: string;
    readonly reason: string;
    readonly durationMinutes: number;
    readonly ipAddress: string | undefined;
    readonly correlationId: string | undefined;
  }): Promise<SupportAccessGrantDto | undefined>;

  /** Closes the caller's live grant. `undefined` when they had none — not an error. */
  close(staffAuthUserId: string): Promise<EndedGrantDto | undefined>;
}

/** Who reached into which client, and when they left (§8.4). */
export interface SupportAccessAudit {
  record(input: {
    readonly actorId: string;
    readonly action: 'platform.support_access_granted' | 'platform.support_access_ended';
    readonly tenantId: string;
    readonly memberId: string;
    readonly changes: Readonly<Record<string, string>>;
  }): Promise<void>;
}

const MAX_SEARCH_PAGE = 50;
const DEFAULT_SEARCH_PAGE = 20;

/**
 * How long a grant lasts.
 *
 * Long enough to work through a support conversation, short enough that walking away from
 * the keyboard closes it. Two hours is the ceiling because a session that outlives an
 * afternoon has stopped being tied to the reason it was opened for.
 */
const DEFAULT_DURATION_MINUTES = 30;
const MAX_DURATION_MINUTES = 120;

/** A reason has to be a sentence. Ten characters is a word; this is a reviewable statement. */
const MIN_REASON_LENGTH = 20;
const MAX_REASON_LENGTH = 500;

export interface SearchMembersCommand {
  readonly query?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface BeginSupportAccessCommand {
  readonly memberId: string;
  readonly reason: string;
  readonly durationMinutes?: number | undefined;
  readonly ipAddress?: string | undefined;
  readonly correlationId?: string | undefined;
}

export class MemberNotReachableError extends ValidationError {
  public constructor(memberId: string) {
    super('memberId', `no active member with id ${memberId} in a company we still serve`);
  }
}

export interface SupportAccessAdministration {
  readonly searchMembers: AuthorizedUseCase<SearchMembersCommand, readonly TenantMemberDto[]>;
  readonly begin: AuthorizedUseCase<BeginSupportAccessCommand, SupportAccessGrantDto>;
  readonly end: AuthorizedUseCase<Record<string, never>, EndedGrantDto | undefined>;
}

export interface SupportAccessDependencies {
  readonly pep: PolicyEnforcementPoint;
  readonly directory: SupportAccessDirectory;
  readonly audit: SupportAccessAudit;
}

export function buildSupportAccessAdministration(
  dependencies: SupportAccessDependencies,
): SupportAccessAdministration {
  const { pep, directory, audit } = dependencies;

  /** Closes whatever is open and records it. Shared by `end` and by re-targeting a grant. */
  async function closeAndRecord(actor: Actor, why: string): Promise<EndedGrantDto | undefined> {
    const ended = await directory.close(actor.actorId);
    // Nothing closed means nothing to record. An audit row for a session that was not
    // open would put a fiction in a six-year record.
    if (ended === undefined) return undefined;

    await audit.record({
      actorId: actor.actorId,
      action: 'platform.support_access_ended',
      tenantId: ended.tenantId,
      memberId: ended.memberId,
      changes: { grantId: ended.grantId, endedBecause: why },
    });

    return ended;
  }

  return {
    /**
     * Finding a person is a smaller power than reading their company's books, and it is
     * gated on the same capability anyway: the only thing anyone does with this list is
     * open a grant from it.
     */
    searchMembers: authorizedUseCase(pep, {
      name: 'SearchTenantMembersForSupportAccess',
      requirement: requireAll(SUPPORT_ACCESS),
      handler: (_actor: Actor, command) =>
        directory.searchMembers({
          query: command.query?.trim() === '' ? undefined : command.query?.trim(),
          tenantId: command.tenantId,
          limit: Math.min(command.limit ?? DEFAULT_SEARCH_PAGE, MAX_SEARCH_PAGE),
        }),
    }),

    begin: authorizedUseCase(pep, {
      name: 'BeginSupportAccess',
      requirement: requireAll(SUPPORT_ACCESS),
      handler: async (actor: Actor, command) => {
        const reason = command.reason.trim();
        if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
          throw new ValidationError(
            'reason',
            'entering a client account needs a reason a reviewer can weigh',
          );
        }

        const minutes = command.durationMinutes ?? DEFAULT_DURATION_MINUTES;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DURATION_MINUTES) {
          throw new ValidationError(
            'durationMinutes',
            `a grant lasts between 1 and ${String(MAX_DURATION_MINUTES)} minutes`,
          );
        }

        // Moving from one client to another ends the first session in the trail rather
        // than letting it trail off. Without this the record shows someone entering three
        // companies and leaving one.
        await closeAndRecord(actor, 'superseded');

        const granted = await directory.open({
          staffAuthUserId: actor.actorId,
          memberId: command.memberId,
          reason,
          durationMinutes: minutes,
          ipAddress: command.ipAddress,
          correlationId: command.correlationId,
        });

        if (granted === undefined) throw new MemberNotReachableError(command.memberId);

        await audit.record({
          actorId: actor.actorId,
          action: 'platform.support_access_granted',
          tenantId: granted.tenantId,
          memberId: granted.memberId,
          changes: {
            grantId: granted.grantId,
            // The role, not the person's address: the trail needs to say what powers were
            // taken on, and the member id already says whose account it was.
            roleCode: granted.roleCode,
            expiresAt: granted.expiresAt,
            reason,
          },
        });

        return granted;
      },
    }),

    /**
     * Handing it back.
     *
     * Deliberately requires no capability. While a grant is live the request no longer
     * carries any platform permission — that is the point of the overlay — so gating the
     * exit on one would trap the staff member inside the client's account with no way out
     * but signing out entirely.
     *
     * Ungated is safe here because the operation is scoped to the caller's own identity:
     * it closes *their* grant or nothing. Someone who has none gets `undefined`, which is
     * what "return to my profile" means for a person who never left it.
     */
    end: authorizedUseCase(pep, {
      name: 'EndSupportAccess',
      requirement: openToEveryMember(
        'the exit from a support session, scoped to the caller’s own grant and to no other',
      ),
      handler: (actor: Actor) => closeAndRecord(actor, 'returned'),
    }),
  };
}
