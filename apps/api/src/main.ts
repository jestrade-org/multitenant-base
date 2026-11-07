import { pino } from 'pino';

import { buildContainer } from './composition/container.js';
import { ConfigurationError, loadConfig } from './config/environment.js';
import { buildServer } from './http/server.js';
import { installShutdownHandlers } from './lifecycle/shutdown.js';

/**
 * Entry point of the single Node service: HTTP API, application/domain layers and
 * workers in one process (§2).
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const logger = pino({
    level: config.logging.level,
    // Structured JSON only. Messages are static strings with structured fields, so
    // they aggregate; interpolated prose does not.
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      // A careless call site must not be able to leak a credential or PII. This is
      // the floor, not the whole policy: government identifiers, bank details and
      // complete business records never reach a log line in the first place.
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.secret',
        '*.token',
        '*.clientSecret',
      ],
      censor: '[redacted]',
    },
    ...(config.isProduction ? {} : { transport: { target: 'pino-pretty' } }),
  });

  const container = buildContainer({ config, logger });

  let acceptingTraffic = true;

  const app = await buildServer({
    config,
    logger,
    readiness: container.readiness,
    isAcceptingTraffic: () => acceptingTraffic,
    tenantDirectory: container.tenantDirectory,
    auth: container.auth,
    controlDatabase: container.controlDatabase,
    audit: container.audit,
    roles: {
      withRoles: container.platform.withRoles,
      withApiKeys: container.platform.withApiKeys,
    },
    platform: { withPlatform: container.platform.withPlatform },
    plans: { withPlans: container.platform.withPlans },
    queues: { withQueues: container.platform.withQueues },
    auditTrail: { withAuditTrail: container.platform.withAuditTrail },
    supportAccess: { withSupportAccess: container.platform.withSupportAccess },
  });

  installShutdownHandlers({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    beginDraining: () => {
      acceptingTraffic = false;
    },
    steps: [
      { name: 'http-server', run: () => app.close() },
      { name: 'workers', run: () => container.workers.stop() },
      { name: 'infrastructure', run: () => container.dispose() },
    ],
  });

  await container.workers.start();
  await app.listen({ host: config.http.host, port: config.http.port });

  logger.info(
    {
      port: config.http.port,
      nodeEnv: config.nodeEnv,
      workersEnabled: config.workers.enabled,
      readinessChecks: container.readiness.registered,
    },
    'api started',
  );
}

try {
  await main();
} catch (error: unknown) {
  // The logger may not exist yet when configuration itself is invalid, so this one
  // failure path writes to stderr directly. It is the only place that may.
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`Failed to start: ${String(error)}\n`);
  process.exit(1);
}
