import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import type { StateStore } from "./persistence";

const challengeTtlMs = 5 * 60 * 1_000;
const adminAccessTtlMs = 15 * 60 * 1_000;
const recoveryCodeCount = 10;
const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const deviceNameSchema = z.string().trim().min(2).max(64);
const registrationOptionsSchema = z.object({
  deviceName: deviceNameSchema,
  bootstrapCode: z.string().min(16).max(256).optional(),
  recoveryCode: z.string().max(64).optional()
}).strict();
const registrationVerificationSchema = z.object({
  requestId: z.string().uuid(),
  response: z.unknown()
}).strict();
const authenticationVerificationSchema = z.object({
  requestId: z.string().uuid(),
  response: z.unknown()
}).strict();
const recoveryAcknowledgementSchema = z.object({ acknowledgementToken: z.string().uuid() }).strict();

const registrationChallengeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bootstrap"),
    sessionId: z.string().uuid(),
    userId: z.string().uuid(),
    challenge: z.string().min(16),
    deviceName: deviceNameSchema,
    expiresAt: z.number().int().positive()
  }).strict(),
  z.object({
    kind: z.literal("elevated"),
    sessionId: z.string().uuid(),
    userId: z.string().uuid(),
    challenge: z.string().min(16),
    deviceName: deviceNameSchema,
    expiresAt: z.number().int().positive()
  }).strict(),
  z.object({
    kind: z.literal("recovery"),
    sessionId: z.string().uuid(),
    userId: z.string().uuid(),
    challenge: z.string().min(16),
    deviceName: deviceNameSchema,
    recoveryCodeHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive()
  }).strict()
]);

const authenticationChallengeSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  challenge: z.string().min(16),
  expiresAt: z.number().int().positive()
}).strict();

const adminAccessRecordSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  credentialId: z.string().min(16),
  method: z.literal("passkey")
}).strict();
const recoveryAcknowledgementRecordSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  credentialId: z.string().min(16)
}).strict();

type AdminSession = Readonly<{
  id: string;
  playerId: string;
  profile: Readonly<{ email: string; displayName: string }>;
}>;

export type AdminPasskeyCredential = Readonly<{
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: readonly AuthenticatorTransportFuture[];
  deviceName: string;
  backedUp: boolean;
}>;

export class AdminPasskeyConflictError extends Error {
  override readonly name = "AdminPasskeyConflictError";
}

type CredentialRow = QueryResultRow & {
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  device_name: string;
  backed_up: boolean;
};

function credentialFromRow(row: CredentialRow): AdminPasskeyCredential {
  const counter = Number(row.counter);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Stored passkey counter is invalid.");
  return {
    id: row.credential_id,
    publicKey: Uint8Array.from(row.public_key),
    counter,
    transports: row.transports as AuthenticatorTransportFuture[],
    deviceName: row.device_name,
    backedUp: row.backed_up
  };
}

async function appendAudit(
  client: PoolClient,
  userId: string,
  action: string,
  details: Readonly<Record<string, unknown>>,
  now: Date
): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_log (
       audit_id, actor_user_id, target_user_id, action, details, occurred_at
     ) VALUES ($1, $2, NULL, $3, $4::jsonb, $5)`,
    [randomUUID(), userId, action, JSON.stringify(details), now]
  );
}

export class PostgresAdminPasskeyRepository {
  constructor(private readonly pool: Pool) {}

  async listCredentials(userId: string): Promise<readonly AdminPasskeyCredential[]> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT credential_id, public_key, counter::text, transports, device_name, backed_up
       FROM admin_passkey_credentials
       WHERE user_id = $1
       ORDER BY created_at, credential_id`,
      [userId]
    );
    return result.rows.map(credentialFromRow);
  }

  async findCredential(userId: string, credentialId: string): Promise<AdminPasskeyCredential | null> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT credential_id, public_key, counter::text, transports, device_name, backed_up
       FROM admin_passkey_credentials
       WHERE user_id = $1 AND credential_id = $2`,
      [userId, credentialId]
    );
    return result.rows[0] ? credentialFromRow(result.rows[0]) : null;
  }

  async hasUnusedRecoveryCode(userId: string, codeHash: Buffer): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM admin_passkey_recovery_codes
       WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [userId, codeHash]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async enrollCredential(input: {
    userId: string;
    credential: AdminPasskeyCredential;
    authorization: "bootstrap" | "elevated" | { recoveryCodeHash: Buffer };
    initialRecoveryCodeHashes?: readonly Buffer[];
    now: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.userId]);
      if (input.authorization === "bootstrap") {
        const existing = await client.query(
          "SELECT 1 FROM admin_passkey_credentials WHERE user_id = $1 LIMIT 1",
          [input.userId]
        );
        if ((existing.rowCount ?? 0) > 0) {
          throw new AdminPasskeyConflictError("A passkey is already enrolled; authenticate or use a recovery code.");
        }
      } else if (typeof input.authorization === "object") {
        const consumed = await client.query(
          `UPDATE admin_passkey_recovery_codes
           SET used_at = $3
           WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
           RETURNING user_id`,
          [input.userId, input.authorization.recoveryCodeHash, input.now]
        );
        if ((consumed.rowCount ?? 0) !== 1) {
          throw new AdminPasskeyConflictError("The recovery code is invalid or has already been used.");
        }
      }

      await client.query(
        `INSERT INTO admin_passkey_credentials (
           credential_id, user_id, public_key, counter, transports, device_name, backed_up, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.credential.id,
          input.userId,
          Buffer.from(input.credential.publicKey),
          input.credential.counter,
          [...input.credential.transports],
          input.credential.deviceName,
          input.credential.backedUp,
          input.now
        ]
      );

      if (input.initialRecoveryCodeHashes) {
        await client.query("DELETE FROM admin_passkey_recovery_codes WHERE user_id = $1", [input.userId]);
        for (const codeHash of input.initialRecoveryCodeHashes) {
          await client.query(
            `INSERT INTO admin_passkey_recovery_codes (user_id, code_hash, created_at)
             VALUES ($1, $2, $3)`,
            [input.userId, codeHash, input.now]
          );
        }
      }
      await appendAudit(client, input.userId, "admin.passkey.enrolled", {
        credentialIdHash: createHash("sha256").update(input.credential.id).digest("hex"),
        deviceName: input.credential.deviceName,
        backedUp: input.credential.backedUp,
        enrollment: typeof input.authorization === "object" ? "recovery" : input.authorization
      }, input.now);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AdminPasskeyConflictError("This passkey is already enrolled.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAuthentication(input: {
    userId: string;
    credentialId: string;
    previousCounter: number;
    newCounter: number;
    now: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE admin_passkey_credentials
         SET counter = $4, last_used_at = $5
         WHERE user_id = $1 AND credential_id = $2 AND counter = $3
         RETURNING credential_id`,
        [input.userId, input.credentialId, input.previousCounter, input.newCounter, input.now]
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new AdminPasskeyConflictError("The passkey counter changed; authenticate again.");
      }
      await appendAudit(client, input.userId, "admin.passkey.authenticated", {
        credentialIdHash: createHash("sha256").update(input.credentialId).digest("hex")
      }, input.now);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceRecoveryCodes(userId: string, codeHashes: readonly Buffer[], now: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);
      await client.query("DELETE FROM admin_passkey_recovery_codes WHERE user_id = $1", [userId]);
      for (const codeHash of codeHashes) {
        await client.query(
          "INSERT INTO admin_passkey_recovery_codes (user_id, code_hash, created_at) VALUES ($1, $2, $3)",
          [userId, codeHash, now]
        );
      }
      await appendAudit(client, userId, "admin.recovery-codes.replaced", { count: codeHashes.length }, now);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export type AdminPasskeyRepository = Pick<PostgresAdminPasskeyRepository,
  | "listCredentials"
  | "findCredential"
  | "hasUnusedRecoveryCode"
  | "enrollCredential"
  | "recordAuthentication"
  | "replaceRecoveryCodes"
>;

export type AdminWebAuthnAdapter = Readonly<{
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}>;

const defaultWebAuthnAdapter: AdminWebAuthnAdapter = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
};

function secureStringMatches(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function newRecoveryCodes(): readonly string[] {
  return Array.from({ length: recoveryCodeCount }, () => {
    const bytes = randomBytes(20);
    const token = Array.from(bytes, (byte) => recoveryAlphabet[byte & 31]!).join("");
    return `RM-${token.slice(0, 5)}-${token.slice(5, 10)}-${token.slice(10, 15)}-${token.slice(15, 20)}`;
  });
}

function normalizeRecoveryCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^RM-(?:[A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/.test(normalized) ? normalized : null;
}

function recoveryCodeHash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function accessKey(token: string): string {
  return `auth:admin-passkey-access:${token}`;
}

function registrationChallengeKey(requestId: string): string {
  return `auth:admin-passkey-registration:${requestId}`;
}

function authenticationChallengeKey(requestId: string): string {
  return `auth:admin-passkey-authentication:${requestId}`;
}

function recoveryAcknowledgementKey(token: string): string {
  return `auth:admin-passkey-recovery-ack:${token}`;
}

export class AdminPasskeyService {
  constructor(
    private readonly repository: AdminPasskeyRepository,
    private readonly state: StateStore,
    private readonly options: {
      rpName: string;
      rpId: string;
      origin: string;
      bootstrapSecret: string;
      now?: () => Date;
      webauthn?: AdminWebAuthnAdapter;
    }
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async status(userId: string): Promise<{ configured: boolean; credentialCount: number }> {
    const credentials = await this.repository.listCredentials(userId);
    return { configured: credentials.length > 0, credentialCount: credentials.length };
  }

  async hasAccess(sessionId: string, userId: string, token: string | undefined): Promise<boolean> {
    if (!token || !z.string().uuid().safeParse(token).success) return false;
    const record = adminAccessRecordSchema.safeParse(await this.state.get<unknown>(accessKey(token)));
    return record.success && record.data.sessionId === sessionId && record.data.userId === userId;
  }

  async revokeAccess(token: string | undefined): Promise<void> {
    if (token && z.string().uuid().safeParse(token).success) await this.state.delete(accessKey(token));
  }

  async registrationOptions(input: {
    session: AdminSession;
    deviceName: string;
    bootstrapCode?: string;
    recoveryCode?: string;
    accessToken?: string;
  }): Promise<{ requestId: string; options: unknown }> {
    const credentials = await this.repository.listCredentials(input.session.playerId);
    let authorization: z.infer<typeof registrationChallengeSchema>["kind"];
    let recoveryHashHex: string | undefined;
    if (credentials.length === 0) {
      if (!input.bootstrapCode || !secureStringMatches(input.bootstrapCode, this.options.bootstrapSecret)) {
        throw new AdminPasskeyConflictError("The one-time administrator bootstrap code is incorrect.");
      }
      authorization = "bootstrap";
    } else if (await this.hasAccess(input.session.id, input.session.playerId, input.accessToken)) {
      authorization = "elevated";
    } else {
      const normalizedCode = input.recoveryCode ? normalizeRecoveryCode(input.recoveryCode) : null;
      if (!normalizedCode) throw new AdminPasskeyConflictError("Enter a valid unused recovery code.");
      const hash = recoveryCodeHash(normalizedCode);
      if (!(await this.repository.hasUnusedRecoveryCode(input.session.playerId, hash))) {
        throw new AdminPasskeyConflictError("Enter a valid unused recovery code.");
      }
      authorization = "recovery";
      recoveryHashHex = hash.toString("hex");
    }

    const options = await (this.options.webauthn ?? defaultWebAuthnAdapter).generateRegistrationOptions({
      rpName: this.options.rpName,
      rpID: this.options.rpId,
      userID: new TextEncoder().encode(input.session.playerId),
      userName: input.session.profile.email.trim().toLowerCase(),
      userDisplayName: input.session.profile.displayName,
      attestationType: "none",
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: [...credential.transports]
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required"
      },
      supportedAlgorithmIDs: [-7, -257],
      timeout: challengeTtlMs
    });
    const requestId = randomUUID();
    const expiresAt = this.now().getTime() + challengeTtlMs;
    const record = authorization === "recovery"
      ? {
          kind: authorization,
          sessionId: input.session.id,
          userId: input.session.playerId,
          challenge: options.challenge,
          deviceName: input.deviceName,
          recoveryCodeHash: recoveryHashHex!,
          expiresAt
        }
      : {
          kind: authorization,
          sessionId: input.session.id,
          userId: input.session.playerId,
          challenge: options.challenge,
          deviceName: input.deviceName,
          expiresAt
        };
    await this.state.set(registrationChallengeKey(requestId), record, challengeTtlMs);
    return { requestId, options };
  }

  async verifyRegistration(input: {
    session: AdminSession;
    requestId: string;
    response: RegistrationResponseJSON;
    accessToken?: string;
  }): Promise<{
    accessToken?: string;
    recoveryCodes?: readonly string[];
    recoveryAcknowledgementToken?: string;
  }> {
    const key = registrationChallengeKey(input.requestId);
    const parsed = registrationChallengeSchema.safeParse(await this.state.get<unknown>(key));
    await this.state.delete(key);
    const now = this.now();
    if (!parsed.success
      || parsed.data.sessionId !== input.session.id
      || parsed.data.userId !== input.session.playerId
      || parsed.data.expiresAt <= now.getTime()) {
      throw new AdminPasskeyConflictError("The passkey enrollment request expired. Start again.");
    }
    if (parsed.data.kind === "elevated"
      && !(await this.hasAccess(input.session.id, input.session.playerId, input.accessToken))) {
      throw new AdminPasskeyConflictError("Authenticate with an existing passkey before adding another.");
    }
    const verification = await (this.options.webauthn ?? defaultWebAuthnAdapter).verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: parsed.data.challenge,
      expectedOrigin: this.options.origin,
      expectedRPID: this.options.rpId,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new AdminPasskeyConflictError("The passkey could not be verified.");
    }
    const { credential, credentialBackedUp } = verification.registrationInfo;
    const recoveryCodes = parsed.data.kind === "bootstrap" ? newRecoveryCodes() : undefined;
    await this.repository.enrollCredential({
      userId: input.session.playerId,
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
        deviceName: parsed.data.deviceName,
        backedUp: credentialBackedUp
      },
      authorization: parsed.data.kind === "recovery"
        ? { recoveryCodeHash: Buffer.from(parsed.data.recoveryCodeHash, "hex") }
        : parsed.data.kind,
      ...(recoveryCodes ? { initialRecoveryCodeHashes: recoveryCodes.map((code) => recoveryCodeHash(code)) } : {}),
      now
    });
    if (recoveryCodes) {
      const recoveryAcknowledgementToken = randomUUID();
      await this.state.set(recoveryAcknowledgementKey(recoveryAcknowledgementToken), {
        sessionId: input.session.id,
        userId: input.session.playerId,
        credentialId: credential.id
      }, challengeTtlMs);
      return { recoveryCodes, recoveryAcknowledgementToken };
    }
    return { accessToken: await this.issueAccess(input.session, credential.id) };
  }

  async acknowledgeRecoveryCodes(session: AdminSession, token: string): Promise<string> {
    const key = recoveryAcknowledgementKey(token);
    const parsed = recoveryAcknowledgementRecordSchema.safeParse(await this.state.get<unknown>(key));
    await this.state.delete(key);
    if (!parsed.success || parsed.data.sessionId !== session.id || parsed.data.userId !== session.playerId) {
      throw new AdminPasskeyConflictError("The recovery-code acknowledgement expired. Authenticate with the new passkey.");
    }
    return this.issueAccess(session, parsed.data.credentialId);
  }

  async authenticationOptions(session: AdminSession): Promise<{ requestId: string; options: unknown }> {
    const credentials = await this.repository.listCredentials(session.playerId);
    if (credentials.length === 0) throw new AdminPasskeyConflictError("Enroll an administrator passkey first.");
    const options = await (this.options.webauthn ?? defaultWebAuthnAdapter).generateAuthenticationOptions({
      rpID: this.options.rpId,
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: [...credential.transports]
      })),
      userVerification: "required",
      timeout: challengeTtlMs
    });
    const requestId = randomUUID();
    await this.state.set(authenticationChallengeKey(requestId), {
      sessionId: session.id,
      userId: session.playerId,
      challenge: options.challenge,
      expiresAt: this.now().getTime() + challengeTtlMs
    }, challengeTtlMs);
    return { requestId, options };
  }

  async verifyAuthentication(input: {
    session: AdminSession;
    requestId: string;
    response: AuthenticationResponseJSON;
  }): Promise<string> {
    const key = authenticationChallengeKey(input.requestId);
    const parsed = authenticationChallengeSchema.safeParse(await this.state.get<unknown>(key));
    await this.state.delete(key);
    const now = this.now();
    if (!parsed.success
      || parsed.data.sessionId !== input.session.id
      || parsed.data.userId !== input.session.playerId
      || parsed.data.expiresAt <= now.getTime()) {
      throw new AdminPasskeyConflictError("The passkey request expired. Start again.");
    }
    const credential = await this.repository.findCredential(input.session.playerId, input.response.id);
    if (!credential) throw new AdminPasskeyConflictError("The passkey is not registered for this administrator.");
    const verification = await (this.options.webauthn ?? defaultWebAuthnAdapter).verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: parsed.data.challenge,
      expectedOrigin: this.options.origin,
      expectedRPID: this.options.rpId,
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: [...credential.transports]
      },
      requireUserVerification: true
    });
    if (!verification.verified) throw new AdminPasskeyConflictError("The passkey could not be verified.");
    await this.repository.recordAuthentication({
      userId: input.session.playerId,
      credentialId: credential.id,
      previousCounter: credential.counter,
      newCounter: verification.authenticationInfo.newCounter,
      now
    });
    return this.issueAccess(input.session, credential.id);
  }

  async replaceRecoveryCodes(session: AdminSession, accessToken: string | undefined): Promise<readonly string[]> {
    if (!(await this.hasAccess(session.id, session.playerId, accessToken))) {
      throw new AdminPasskeyConflictError("Authenticate with a passkey first.");
    }
    const codes = newRecoveryCodes();
    await this.repository.replaceRecoveryCodes(
      session.playerId,
      codes.map((code) => recoveryCodeHash(code)),
      this.now()
    );
    return codes;
  }

  private async issueAccess(session: AdminSession, credentialId: string): Promise<string> {
    const token = randomUUID();
    await this.state.set(accessKey(token), {
      sessionId: session.id,
      userId: session.playerId,
      credentialId,
      method: "passkey"
    }, adminAccessTtlMs);
    return token;
  }
}

export async function registerAdminPasskeyRoutes(app: FastifyInstance, options: {
  service: AdminPasskeyService;
  resolveSession: (request: FastifyRequest) => Promise<AdminSession | null>;
  adminEmails: ReadonlySet<string>;
  cookieSecure: boolean;
}): Promise<void> {
  const requireAdminSession = async (request: FastifyRequest): Promise<AdminSession | null> => {
    const session = await options.resolveSession(request);
    return session && options.adminEmails.has(session.profile.email.trim().toLowerCase()) ? session : null;
  };
  const setAccessCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie("rm_admin", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: options.cookieSecure,
      path: "/",
      maxAge: adminAccessTtlMs / 1_000
    });
  };
  const sendFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AdminPasskeyConflictError) return reply.code(409).send({ error: error.message });
    requestLogSafe(app, error);
    return reply.code(401).send({ error: "The passkey operation could not be verified." });
  };

  app.get("/api/admin/passkeys/status", {
    config: { rateLimit: { max: 60, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireAdminSession(request);
    if (!session) return reply.code(403).send({ error: "Administrator access required." });
    const status = await options.service.status(session.playerId);
    return reply.send({
      ...status,
      unlocked: await options.service.hasAccess(session.id, session.playerId, request.cookies.rm_admin)
    });
  });

  app.post("/api/admin/passkeys/registration/options", {
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireAdminSession(request);
    if (!session) return reply.code(403).send({ error: "Administrator access required." });
    const parsed = registrationOptionsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Check the device name and enrollment credential." });
    try {
      return reply.send(await options.service.registrationOptions({
        session,
        deviceName: parsed.data.deviceName,
        ...(parsed.data.bootstrapCode ? { bootstrapCode: parsed.data.bootstrapCode } : {}),
        ...(parsed.data.recoveryCode ? { recoveryCode: parsed.data.recoveryCode } : {}),
        ...(request.cookies.rm_admin ? { accessToken: request.cookies.rm_admin } : {})
      }));
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post("/api/admin/passkeys/registration/verify", {
    config: { rateLimit: { max: 10, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireAdminSession(request);
    if (!session) return reply.code(403).send({ error: "Administrator access required." });
    const parsed = registrationVerificationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "The passkey response is invalid." });
    try {
      const verified = await options.service.verifyRegistration({
        session,
        requestId: parsed.data.requestId,
        response: parsed.data.response as RegistrationResponseJSON,
        ...(request.cookies.rm_admin ? { accessToken: request.cookies.rm_admin } : {})
      });
      if (verified.accessToken) setAccessCookie(reply, verified.accessToken);
      return reply.send({
        ...(verified.recoveryCodes ? { recoveryCodes: verified.recoveryCodes } : {}),
        ...(verified.recoveryAcknowledgementToken
          ? { recoveryAcknowledgementToken: verified.recoveryAcknowledgementToken }
          : {})
      });
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post("/api/admin/passkeys/registration/acknowledge-recovery", {
    config: { rateLimit: { max: 10, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireAdminSession(request);
    if (!session) return reply.code(403).send({ error: "Administrator access required." });
    const parsed = recoveryAcknowledgementSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "The acknowledgement is invalid." });
    try {
      const accessToken = await options.service.acknowledgeRecoveryCodes(
        session,
        parsed.data.acknowledgementToken
      );
      setAccessCookie(reply, accessToken);
      return reply.code(204).send();
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post("/api/admin/passkeys/authentication/options", {
    config: { rateLimit: { max: 10, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireAdminSession(request);
    if (!session) return reply.code(403).send({ error: "Administrator access required." });
    try {
      return reply.send(await options.service.authenticationOptions(session));
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post("/api/admin/passkeys/authentication/verify", {
    config: { rateLimit: { max: 10, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireAdminSession(request);
    if (!session) return reply.code(403).send({ error: "Administrator access required." });
    const parsed = authenticationVerificationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "The passkey response is invalid." });
    try {
      const token = await options.service.verifyAuthentication({
        session,
        requestId: parsed.data.requestId,
        response: parsed.data.response as AuthenticationResponseJSON
      });
      setAccessCookie(reply, token);
      return reply.code(204).send();
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post("/api/admin/passkeys/recovery-codes", {
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const session = await requireAdminSession(request);
    if (!session) return reply.code(403).send({ error: "Administrator access required." });
    try {
      const recoveryCodes = await options.service.replaceRecoveryCodes(session, request.cookies.rm_admin);
      return reply.send({ recoveryCodes });
    } catch (error) {
      return sendFailure(reply, error);
    }
  });
}

function requestLogSafe(app: FastifyInstance, error: unknown): void {
  app.log.warn({ err: error }, "Administrator passkey verification failed");
}
