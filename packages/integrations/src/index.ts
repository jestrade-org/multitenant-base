/**
 * Integrations — public API, API keys and secrets, webhooks.
 *
 * This file is the context's entire public API. Other contexts reach this one only
 * through the symbols listed here — never by importing its `domain/` directly and
 * never by reading its tables. Cross-context communication goes through this surface
 * or through a domain event.
 */
export {
  ApiKey,
  ApiKeyRevokedError,
  API_KEY_ENVIRONMENTS,
  formatApiToken,
  formatKeyPrefix,
  parseApiToken,
  type ApiKeyEnvironment,
  type ApiKeySnapshot,
  type ParsedToken,
  type SecretHasher,
} from './domain/apiKey.js';

export {
  ApiKeyNotFoundError,
  buildApiKeyAdministration,
  CapabilityNotDelegatableError,
  type ApiKeyAdministration,
  type ApiKeyAudit,
  type ApiKeyDto,
  type ApiKeyRepository,
  type IssuedApiKey,
  type SecretGenerator,
} from './application/manageApiKeys.js';

export { RandomSecretGenerator, Sha256SecretHasher } from './infrastructure/sha256SecretHasher.js';

export { PostgresApiKeyRepository, type SqlClient } from './infrastructure/postgresApiKeys.js';
