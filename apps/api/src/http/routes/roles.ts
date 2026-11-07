import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { MemberAdministration, RoleAdministration } from '@multitenant-base/iam';
import { API_KEY_ENVIRONMENTS, type ApiKeyAdministration } from '@multitenant-base/integrations';
import type { Actor } from '@multitenant-base/shared-kernel';

import type { Principal } from '../plugins/authentication.js';

/**
 * Role administration (§8.3, VC-31, VC-74).
 *
 * Thin: validate, resolve the use case, map to HTTP. Every capability check happens inside
 * the use case, which is also where the audit event is written — a route that checked for
 * itself would be a second, weaker decision point.
 */

export interface RolesContext {
  readonly actor: Actor;
  readonly roles: RoleAdministration;
  readonly members: MemberAdministration;
}

export interface RoleRoutesOptions {
  readonly withRoles: <T>(
    principal: Principal,
    work: (context: RolesContext) => Promise<T>,
  ) => Promise<T>;
  /**
   * API keys, on the control connection (§10.1, VC-79).
   *
   * Alongside roles and members because they are the same screenful of decisions: who may
   * act, and with what. Optional so a server without integrations can still be built.
   */
  readonly withApiKeys?: <T>(
    principal: Principal,
    work: (context: { actor: Actor; keys: ApiKeyAdministration }) => Promise<T>,
  ) => Promise<T>;
}

const keyParamsSchema = z.object({ keyId: z.string().uuid() }).strict();

/**
 * `.strict()`: a body carrying `tenantId` or a secret is refused rather than ignored.
 *
 * The capabilities are checked again in the use case against what the creator holds — a
 * key is a delegation of their authority, never a widening of it.
 */
const createKeySchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    environment: z.enum(API_KEY_ENVIRONMENTS),
    permissions: z.array(z.string().max(60)).min(1).max(40),
  })
  .strict();

const memberParamsSchema = z.object({ memberId: z.string().uuid() }).strict();

const inviteSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    fullName: z.string().trim().min(2).max(160),
    roleCode: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  })
  .strict();

const roleChangeSchema = z
  .object({ roleCode: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) })
  .strict();

/**
 * `.strict()` on all three, and deliberately so.
 *
 * A body carrying `permissions` or `tenantId` is the mass-assignment case (API3): a client
 * must not be able to grant itself a capability by inventing a field, and silent
 * acceptance is how that goes unnoticed.
 */
const statusSchema = z.object({ isActive: z.boolean() }).strict();

const createRoleSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    // Bounded: a role carrying every capability twice is a payload, not a request.
    permissions: z.array(z.string().max(60)).min(0).max(100),
  })
  .strict();

const redefineRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    permissions: z.array(z.string().max(60)).max(100).optional(),
  })
  .strict();

const roleIdSchema = z.object({ roleId: z.string().uuid() }).strict();

export const roleRoutes: FastifyPluginCallback<RoleRoutesOptions> = (app, options, ready) => {
  function principalOf(request: { principal?: Principal }): Principal | undefined {
    return request.principal;
  }

  /** The catalogue: what a role *could* be given. One axis of the matrix (VC-74). */
  app.get('/api/v1/iam/permissions', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const catalogue = await options.withRoles(principal, (context) =>
      context.roles.listPermissionCatalogue(context.actor, {}),
    );
    return reply.send(catalogue);
  });

  /** The other axis: system roles plus this tenant's own. */
  app.get('/api/v1/iam/roles', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const roles = await options.withRoles(principal, (context) =>
      context.roles.listRoles(context.actor, {}),
    );
    return reply.send(roles);
  });

  app.post('/api/v1/iam/roles', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const parsed = createRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_ROLE',
          params: { detail: parsed.error.issues[0]?.message ?? 'invalid role' },
        },
      });
    }

    // Optional keys are omitted rather than passed as `undefined`: with
    // `exactOptionalPropertyTypes` those are different things, and the command means
    // "the caller said nothing about this", not "the caller said nothing".
    const created = await options.withRoles(principal, (context) =>
      context.roles.createRole(context.actor, {
        code: parsed.data.code,
        name: parsed.data.name,
        ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
        permissions: parsed.data.permissions,
      }),
    );
    return reply.code(201).header('location', `/api/v1/iam/roles/${created.id}`).send(created);
  });

  app.patch('/api/v1/iam/roles/:roleId', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = roleIdSchema.safeParse(request.params);
    const body = redefineRoleSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_ROLE' } });
    }

    const updated = await options.withRoles(principal, (context) =>
      context.roles.redefineRole(context.actor, {
        roleId: params.data.roleId,
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
        ...(body.data.description === undefined ? {} : { description: body.data.description }),
        ...(body.data.permissions === undefined ? {} : { permissions: body.data.permissions }),
      }),
    );
    return reply.send(updated);
  });

  app.delete('/api/v1/iam/roles/:roleId', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = roleIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_ROLE' } });
    }

    await options.withRoles(principal, (context) =>
      context.roles.deleteRole(context.actor, { roleId: params.data.roleId }),
    );
    return reply.code(204).send();
  });

  /**
   * The company's own users (§9, VC-77).
   *
   * Under the same guard as roles, because they are the same decision seen twice: granting
   * someone a role and defining what that role may do are two halves of "who can act".
   */
  app.get('/api/v1/admin/members', async (request, reply) => {
    const principal = request.principal;
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const members = await options.withRoles(principal, (context) =>
      context.members.listMembers(context.actor, {}),
    );

    return reply.send({ items: members });
  });

  app.post(
    '/api/v1/admin/members',
    // Inviting creates an account at the identity provider and sends mail. A burst is
    // either a mistake or an attempt to use us as a mailer.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      }

      const body = inviteSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_MEMBER',
            params: { field: body.error.issues[0]?.path.join('.') ?? 'body' },
          },
        });
      }

      const member = await options.withRoles(principal, (context) =>
        context.members.inviteMember(context.actor, body.data),
      );

      return reply
        .code(201)
        .header('location', `/api/v1/admin/members/${member.memberId}`)
        .send(member);
    },
  );

  app.put('/api/v1/admin/members/:memberId/role', async (request, reply) => {
    const principal = request.principal;
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = memberParamsSchema.safeParse(request.params);
    const body = roleChangeSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_MEMBER' } });
    }

    const member = await options.withRoles(principal, (context) =>
      context.members.changeMemberRole(context.actor, {
        memberId: params.data.memberId,
        roleCode: body.data.roleCode,
      }),
    );

    return reply.send(member);
  });

  /**
   * Deactivating and reactivating.
   *
   * Not a DELETE: a member is never removed. Their name is on journal entries, approvals
   * and audit rows that outlive their employment, and a deleted row turns those into
   * an unattributable id.
   */
  app.put('/api/v1/admin/members/:memberId/status', async (request, reply) => {
    const principal = request.principal;
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = memberParamsSchema.safeParse(request.params);
    const body = statusSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_MEMBER' } });
    }

    const member = await options.withRoles(principal, (context) =>
      context.members.setMemberActive(context.actor, {
        memberId: params.data.memberId,
        isActive: body.data.isActive,
      }),
    );

    return reply.send(member);
  });

  /**
   * The keys a company has.
   *
   * The list carries prefixes, never secrets. There is nothing else to carry: what was
   * stored is a digest.
   */
  app.get('/api/v1/admin/api-keys', async (request, reply) => {
    const principal = request.principal;
    const withApiKeys = options.withApiKeys;
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }
    if (withApiKeys === undefined) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }

    const items = await withApiKeys(principal, (context) =>
      context.keys.listKeys(context.actor, {}),
    );

    return reply.send({ items });
  });

  /**
   * Minting a key.
   *
   * 201 with the token in the body, once. No endpoint can return it again — there is
   * nothing to return, and an interface that could re-display a key would mean the server
   * kept something a database leak could replay.
   */
  app.post(
    '/api/v1/admin/api-keys',
    // Minting is cheap for us and valuable to an attacker who has a session: a burst is
    // either a mistake or somebody building a set of credentials to keep.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const principal = request.principal;
      const withApiKeys = options.withApiKeys;
      if (principal === undefined) {
        return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      }
      if (withApiKeys === undefined) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      const body = createKeySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_API_KEY',
            params: { field: body.error.issues[0]?.path.join('.') ?? 'body' },
          },
        });
      }

      const issued = await withApiKeys(principal, (context) =>
        context.keys.createKey(context.actor, body.data),
      );

      return reply.code(201).send(issued);
    },
  );

  app.post('/api/v1/admin/api-keys/:keyId/rotation', async (request, reply) => {
    const principal = request.principal;
    const withApiKeys = options.withApiKeys;
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }
    if (withApiKeys === undefined) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }

    const params = keyParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_API_KEY' } });
    }

    const issued = await withApiKeys(principal, (context) =>
      context.keys.rotateKey(context.actor, { keyId: params.data.keyId }),
    );

    return reply.code(201).send(issued);
  });

  /** Revoking. A DELETE on the key's *usability*, never on its row. */
  app.delete('/api/v1/admin/api-keys/:keyId', async (request, reply) => {
    const principal = request.principal;
    const withApiKeys = options.withApiKeys;
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }
    if (withApiKeys === undefined) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }

    const params = keyParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_API_KEY' } });
    }

    const key = await withApiKeys(principal, (context) =>
      context.keys.revokeKey(context.actor, { keyId: params.data.keyId }),
    );

    return reply.send(key);
  });

  ready();
};
