import type { Actor } from '../domain/actor.js';
import { NotAuthorizedError } from '../domain/errors.js';
import type { Permission } from '../domain/permission.js';
import type { Clock } from '../domain/ports.js';

/**
 * The policy enforcement point (§8.3, layer 3).
 *
 * Four layers check authorization; this is the authoritative one. The interface hides
 * what a person cannot do, but that is UX. The route resolves who is asking. RLS is
 * defence in depth — and because the API connects with a role that can reach every
 * tenant's schema, RLS alone would not save us. So the decision is made here, before any
 * state changes, and it is made from a declaration the use case cannot omit.
 *
 * "Cannot omit" is the whole design. A use case is not a function that happens to call a
 * check; it is a function that only becomes callable by being handed a requirement. There
 * is no overload that skips it, so a new use case cannot ship unprotected by forgetting a
 * line — the way every `TODO: add auth check` in every codebase got there.
 */

export type AuthorizationRequirement =
  | { readonly kind: 'all'; readonly permissions: readonly Permission[] }
  | { readonly kind: 'any'; readonly permissions: readonly Permission[] }
  | { readonly kind: 'none'; readonly justification: string };

/** Every listed capability. The default: approving a payment run is not half-approved. */
export function requireAll(...permissions: readonly Permission[]): AuthorizationRequirement {
  if (permissions.length === 0) {
    // An empty list would read as "requires nothing" and grant everyone. If a use case
    // genuinely needs no capability, it has to say so in words that a reviewer will see.
    throw new TypeError('requireAll needs at least one permission; use openToEveryMember');
  }
  return { kind: 'all', permissions };
}

/** Any one of the listed capabilities, for a read that several roles reach differently. */
export function requireAny(...permissions: readonly Permission[]): AuthorizationRequirement {
  if (permissions.length === 0) {
    throw new TypeError('requireAny needs at least one permission; use openToEveryMember');
  }
  return { kind: 'any', permissions };
}

/**
 * No capability required — open to any authenticated member of the tenant.
 *
 * Takes a written justification because it is the one way past this gate, and an
 * unexplained bypass is indistinguishable from an oversight in review.
 */
export function openToEveryMember(justification: string): AuthorizationRequirement {
  if (justification.trim().length < 15) {
    throw new TypeError('openToEveryMember needs a justification a reviewer can weigh');
  }
  return { kind: 'none', justification };
}

export interface AuthorizationAttempt {
  readonly occurredAt: Date;
  readonly useCase: string;
  readonly actorId: string;
  readonly actorType: Actor['actorType'];
  /** Absent for a platform action, which belongs to no company. */
  readonly tenantId: string | undefined;
  readonly roleCode: string;
  readonly outcome: 'granted' | 'denied';
  /** Why it was refused. Empty on a grant. */
  readonly missingPermissions: readonly Permission[];
  /** Set when the actor tried to act on a tenant that is not theirs. */
  readonly attemptedTenantId?: string;
}

/**
 * Where denials are recorded.
 *
 * A port, not a logger: §8.4 makes the audit trail a business record with a six-year
 * retention, not an operational log that rotates away. The adapter that writes it lands
 * with VC-34.
 */
export interface AuthorizationAuditSink {
  record(attempt: AuthorizationAttempt): Promise<void>;
}

export interface PolicyEnforcementPointDependencies {
  readonly clock: Clock;
  readonly auditSink: AuthorizationAuditSink;
}

export class PolicyEnforcementPoint {
  readonly #clock: Clock;
  readonly #auditSink: AuthorizationAuditSink;

  public constructor(dependencies: PolicyEnforcementPointDependencies) {
    this.#clock = dependencies.clock;
    this.#auditSink = dependencies.auditSink;
  }

  /**
   * Decides, records, and throws on refusal.
   *
   * `resourceTenantId` is the tenant of the thing being acted on. Passing it turns the
   * check into an ownership check too, which is what stops the highest-risk failure in a
   * multi-tenant product: a valid session for company A reaching company B's
   * records by id. The error is deliberately identical to a missing-capability refusal —
   * a distinct message would confirm that the other company's record exists.
   */
  public async authorize(
    useCase: string,
    requirement: AuthorizationRequirement,
    actor: Actor,
    resourceTenantId?: string,
  ): Promise<void> {
    // Compared only when the resource names a tenant. A platform actor has none, and an
    // actor with none can never match one — which is the correct answer: staff reaching a
    // tenant's resource by id is exactly what §8.1 forbids without an audited elevation.
    if (resourceTenantId !== undefined && resourceTenantId !== actor.tenantId) {
      await this.#record(useCase, actor, 'denied', [], resourceTenantId);
      throw new NotAuthorizedError(useCase);
    }

    const missing = missingFor(requirement, actor);
    if (missing.length > 0) {
      await this.#record(useCase, actor, 'denied', missing);
      throw new NotAuthorizedError(missing[0] ?? useCase);
    }

    await this.#record(useCase, actor, 'granted', []);
  }

  async #record(
    useCase: string,
    actor: Actor,
    outcome: 'granted' | 'denied',
    missingPermissions: readonly Permission[],
    attemptedTenantId?: string,
  ): Promise<void> {
    // Not wrapped in a try: if the attempt cannot be recorded, the operation does not
    // happen (§8.4). An action nobody can prove took place is worse than a failed request,
    // and this is the layer that decides whether money moves.
    await this.#auditSink.record({
      occurredAt: this.#clock.now(),
      useCase,
      actorId: actor.actorId,
      actorType: actor.actorType,
      tenantId: actor.tenantId,
      roleCode: actor.roleCode,
      outcome,
      missingPermissions,
      ...(attemptedTenantId === undefined ? {} : { attemptedTenantId }),
    });
  }
}

function missingFor(requirement: AuthorizationRequirement, actor: Actor): readonly Permission[] {
  if (requirement.kind === 'none') return [];

  const held = new Set<string>(actor.permissions);
  if (requirement.kind === 'any') {
    const satisfied = requirement.permissions.some((wanted) => held.has(wanted));
    return satisfied ? [] : requirement.permissions;
  }
  return requirement.permissions.filter((wanted) => !held.has(wanted));
}

export interface UseCaseDefinition<Command, Output> {
  /** Stable English name; it is what the audit trail records. */
  readonly name: string;
  readonly requirement: AuthorizationRequirement;
  readonly handler: (actor: Actor, command: Command) => Promise<Output>;
  /** Reads the tenant of the resource being acted on, when the command names one. */
  readonly resourceTenantId?: (command: Command) => string | undefined;
}

export type AuthorizedUseCase<Command, Output> = (
  actor: Actor,
  command: Command,
) => Promise<Output>;

/**
 * Wraps a handler so it cannot run before the decision is made.
 *
 * The handler is unreachable except through the returned function, so "declare your
 * permissions" stops being a convention someone has to remember and becomes the only way
 * to obtain something callable.
 */
export function authorizedUseCase<Command, Output>(
  pep: PolicyEnforcementPoint,
  definition: UseCaseDefinition<Command, Output>,
): AuthorizedUseCase<Command, Output> {
  return async (actor, command) => {
    await pep.authorize(
      definition.name,
      definition.requirement,
      actor,
      definition.resourceTenantId?.(command),
    );
    return definition.handler(actor, command);
  };
}
