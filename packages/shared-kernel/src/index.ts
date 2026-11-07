/**
 * Shared kernel — concepts that genuinely belong to every bounded context.
 *
 * Everything exported here is used by more than one context and changes only by
 * consensus. If a concept belongs to a single context, it does not belong here.
 *
 * This file is the package's entire public API. There is no barrel re-exporting a
 * whole layer: each symbol is listed explicitly.
 */
export {
  currencyOf,
  isCurrencyCode,
  UnknownCurrencyError,
  CURRENCY_CODES,
  type Currency,
  type CurrencyCode,
} from './domain/currency.js';

export {
  Money,
  MONEY_SCALE,
  RoundingMode,
  CurrencyMismatchError,
  InvalidAmountError,
} from './domain/money.js';

export {
  ok,
  err,
  isOk,
  isErr,
  mapResult,
  allResults,
  partitionResults,
  unwrapOrThrow,
  type Result,
} from './domain/result.js';

export {
  DomainError,
  ApplicationError,
  InfrastructureError,
  NotAuthorizedError,
  ConcurrencyConflictError,
  ValidationError,
  type ErrorParams,
} from './domain/errors.js';

export { FixedClock, SequentialIdGenerator, type Clock, type IdGenerator } from './domain/ports.js';

export {
  createDomainEvent,
  DomainEventRecorder,
  type DomainEvent,
  type DomainEventFactoryDeps,
  type NewDomainEvent,
} from './domain/domainEvent.js';

export {
  EVENT_CATALOGUE,
  EVENT_TYPES,
  eventDefinition,
  isKnownEventType,
  type BoundedContext,
  type EventDefinition,
  type EventType,
} from './domain/eventCatalogue.js';

export {
  parseEventEnvelope,
  describeEnvelopeProblems,
  type EnvelopeProblem,
} from './domain/eventEnvelope.js';

export { actorHas, requireTenant, type Actor, type ActorType } from './domain/actor.js';

export {
  isPermissionCode,
  permission,
  permissionsFrom,
  PERMISSIONS,
  type Permission,
  type PermissionCode,
} from './domain/permission.js';

export {
  authorizedUseCase,
  openToEveryMember,
  PolicyEnforcementPoint,
  requireAll,
  requireAny,
  type AuthorizationAttempt,
  type AuthorizationAuditSink,
  type AuthorizationRequirement,
  type AuthorizedUseCase,
  type PolicyEnforcementPointDependencies,
  type UseCaseDefinition,
} from './application/authorization.js';

export {
  deduplicatingEmitter,
  idempotentConsumer,
  type ConsumedEvent,
  type DeduplicatedAlert,
  type ProcessedEventLedger,
  type SuppressionWindow,
} from './application/idempotentConsumer.js';

export { CalendarDate } from './domain/calendarDate.js';
