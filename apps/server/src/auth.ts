import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { profileBadgeSchema, type ProfileBadgeId } from "@trinitymatrix/protocol";
import type { StateStore } from "./persistence";

const challengeTtlMs = 5 * 60 * 1_000;
const sessionTtlMs = 12 * 60 * 60 * 1_000;

const profilePhoneSchema = z.object({
  countryCode: z.string().regex(/^\+[1-9]\d{0,2}$/),
  nationalNumber: z.string().regex(/^\d{4,14}$/)
}).strict().refine(
  ({ countryCode, nationalNumber }) => countryCode.slice(1).length + nationalNumber.length <= 15,
  "The complete phone number must contain at most 15 digits."
);

export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(2).max(24),
  badgeId: profileBadgeSchema,
  phone: profilePhoneSchema.nullable()
}).strict();

export type ProfilePhone = z.infer<typeof profilePhoneSchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

export type PlayerProfile = {
  id: string;
  email: string;
  displayName: string;
  badgeId: ProfileBadgeId;
  phone: ProfilePhone | null;
  createdAt: number;
  updatedAt: number;
};

const playerProfileSchema: z.ZodType<PlayerProfile> = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(2).max(24),
  badgeId: profileBadgeSchema,
  phone: profilePhoneSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
}).strict();

type Challenge = {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: number;
  failedAttempts: number;
};

const challengeSchema: z.ZodType<Challenge> = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  codeHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number(),
  failedAttempts: z.number().int().nonnegative()
}).strict();

type StoredSession = {
  id: string;
  playerId: string;
  expiresAt: number;
};

const storedSessionSchema: z.ZodType<StoredSession> = z.object({
  id: z.string().uuid(),
  playerId: z.string().uuid(),
  expiresAt: z.number(),
  // Accepted only to invalidate old phone-based sessions without crashing startup.
  displayName: z.string().optional()
}).strict().transform(({ displayName: _legacyName, ...session }) => session);

const emailPlayerSchema = z.object({ playerId: z.string().uuid() }).strict();

export type Session = StoredSession & { profile: PlayerProfile };

export interface EmailOtpSender {
  send(email: string, code: string, challengeId: string): Promise<void>;
}

export interface DurableProfileStore {
  upsertUserProfile(input: {
    id: string;
    email: string;
    displayName: string;
    badgeId: ProfileBadgeId;
    phone: { countryCode: string; nationalNumber: string } | null;
    now?: Date;
  }): Promise<{
    id: string;
    email: string;
    displayName: string;
    badgeId: ProfileBadgeId;
    phone: { countryCode: string; nationalNumber: string } | null;
    suspendedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  getUserProfile(userId: string): Promise<{
    id: string;
    email: string;
    displayName: string;
    badgeId: ProfileBadgeId;
    phone: { countryCode: string; nationalNumber: string } | null;
    suspendedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
}

export class MockEmailOtpSender implements EmailOtpSender {
  async send(_email: string, _code: string, _challengeId: string): Promise<void> {
    await Promise.resolve();
  }
}

export class ResendEmailOtpSender implements EmailOtpSender {
  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(email: string, code: string, challengeId: string): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": challengeId
      },
      body: JSON.stringify({
        from: this.from,
        to: [email],
        subject: `${code} is your TrinityMatrix verification code`,
        text: `Your TrinityMatrix verification code is ${code}. It expires in 5 minutes. If you did not request it, you can ignore this email.`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:32px;color:#102027"><h1 style="font-size:24px">TrinityMatrix</h1><p>Use this verification code to enter the ranking arena:</p><p style="font-size:36px;font-weight:800;letter-spacing:8px;margin:28px 0">${code}</p><p>This code expires in 5 minutes. If you did not request it, you can ignore this email.</p></div>`,
        tags: [{ name: "message_type", value: "login_otp" }]
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      let providerDetail = "";
      try {
        const body = await response.json() as { name?: unknown; message?: unknown };
        const name = typeof body.name === "string" ? body.name : "";
        const message = typeof body.message === "string" ? body.message : "";
        providerDetail = [name, message]
          .filter(Boolean)
          .join(": ")
          .replace(/[\r\n\t]+/g, " ")
          .slice(0, 300);
      } catch {
        // Provider response bodies are diagnostic only; never let parsing mask
        // the delivery failure or log unstructured response content.
      }
      throw new Error(`The email provider rejected the OTP request (${response.status})${providerDetail ? `: ${providerDetail}` : "."}`);
    }
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailPlayerKey(email: string): string {
  return `auth:email-player:${createHash("sha256").update(email).digest("hex")}`;
}

function profileKey(playerId: string): string {
  return `auth:profile:${playerId}`;
}

export class AuthService {
  constructor(
    private readonly sender: EmailOtpSender,
    private readonly store: StateStore,
    private readonly options: { otpSecret: string; fixedCode?: string; stateEpoch?: string },
    private readonly durableProfiles?: DurableProfileStore
  ) {
    if (options.otpSecret.length < 16) throw new Error("OTP_HASH_SECRET must contain at least 16 characters.");
    if (options.stateEpoch !== undefined && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(options.stateEpoch)) {
      throw new Error("AUTH_STATE_EPOCH must be a lower-case token containing at most 32 letters, digits, underscores, or hyphens.");
    }
  }

  private transientKey(kind: "challenge" | "session", id: string): string {
    // The epoch intentionally applies only to short-lived authentication state.
    // Profile and email mapping keys remain stable across authentication-provider
    // cutovers, as do all matchmaking and game-state namespaces.
    return this.options.stateEpoch
      ? `auth:${kind}:${this.options.stateEpoch}:${id}`
      : `auth:${kind}:${id}`;
  }

  private codeHash(challengeId: string, email: string, code: string): string {
    return createHmac("sha256", this.options.otpSecret)
      .update(`${challengeId}\n${email}\n${code}`)
      .digest("hex");
  }

  async requestOtp(requestedEmail: string): Promise<string> {
    const email = normalizeEmail(requestedEmail);
    const id = randomUUID();
    const code = this.options.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, "0");
    const challenge: Challenge = {
      id,
      email,
      codeHash: this.codeHash(id, email, code),
      expiresAt: Date.now() + challengeTtlMs,
      failedAttempts: 0
    };
    await this.store.set(this.transientKey("challenge", id), challenge, challengeTtlMs);
    try {
      await this.sender.send(email, code, id);
    } catch (error) {
      await this.store.delete(this.transientKey("challenge", id));
      throw error;
    }
    return id;
  }

  async verifyOtp(challengeId: string, code: string, requestedName?: string): Promise<Session | null> {
    const storedChallenge = await this.store.get<unknown>(this.transientKey("challenge", challengeId));
    const parsedChallenge = challengeSchema.safeParse(storedChallenge);
    const challenge = parsedChallenge.success ? parsedChallenge.data : null;
    if (!challenge) return null;
    const consumed = await this.store.consumeChallenge<unknown>(
      this.transientKey("challenge", challengeId),
      this.codeHash(challenge.id, challenge.email, code),
      Date.now(),
      5
    );
    if (consumed.status !== "verified") return null;
    const verifiedChallenge = challengeSchema.safeParse(consumed.value);
    if (!verifiedChallenge.success) return null;

    const profile = await this.getOrCreateProfile(verifiedChallenge.data.email, requestedName);
    const storedSession: StoredSession = {
      id: randomUUID(),
      playerId: profile.id,
      expiresAt: Date.now() + sessionTtlMs
    };
    await this.store.set(this.transientKey("session", storedSession.id), storedSession, sessionTtlMs);
    return { ...storedSession, profile };
  }

  private async getOrCreateProfile(email: string, requestedName?: string): Promise<PlayerProfile> {
    const storedMapping = await this.store.get<unknown>(emailPlayerKey(email));
    const mapping = emailPlayerSchema.safeParse(storedMapping);
    if (mapping.success) {
      const storedProfile = await this.store.get<unknown>(profileKey(mapping.data.playerId));
      const profile = playerProfileSchema.safeParse(storedProfile);
      if (profile.success) {
        if (!this.durableProfiles) return profile.data;
        const durable = await this.durableProfiles.upsertUserProfile({
          id: profile.data.id,
          email: profile.data.email,
          displayName: profile.data.displayName,
          badgeId: profile.data.badgeId,
          phone: profile.data.phone,
          now: new Date(profile.data.updatedAt)
        });
        const synchronized = this.fromDurableProfile(durable);
        await this.store.set(profileKey(synchronized.id), synchronized);
        await this.store.set(emailPlayerKey(email), { playerId: synchronized.id });
        return synchronized;
      }
    }

    const now = Date.now();
    const fallbackName = email.split("@")[0]!.replace(/[._+-]+/g, " ").trim().slice(0, 24) || "Trinity player";
    const displayName = requestedName?.trim().slice(0, 24) || fallbackName;
    const profile: PlayerProfile = {
      id: mapping.success ? mapping.data.playerId : randomUUID(),
      email,
      displayName: displayName.length >= 2 ? displayName : "Trinity player",
      badgeId: "rookie",
      phone: null,
      createdAt: now,
      updatedAt: now
    };
    const synchronized = this.durableProfiles
      ? this.fromDurableProfile(await this.durableProfiles.upsertUserProfile({
          id: profile.id,
          email: profile.email,
          displayName: profile.displayName,
          badgeId: profile.badgeId,
          phone: profile.phone,
          now: new Date(now)
        }))
      : profile;
    await this.store.set(profileKey(synchronized.id), synchronized);
    await this.store.set(emailPlayerKey(email), { playerId: synchronized.id });
    return synchronized;
  }

  private fromDurableProfile(profile: Awaited<ReturnType<DurableProfileStore["upsertUserProfile"]>>): PlayerProfile {
    return {
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      badgeId: profile.badgeId,
      phone: profile.phone,
      createdAt: profile.createdAt.getTime(),
      updatedAt: profile.updatedAt.getTime()
    };
  }

  async getSession(id?: string): Promise<Session | null> {
    if (!id) return null;
    const stored = await this.store.get<unknown>(this.transientKey("session", id));
    const parsed = storedSessionSchema.safeParse(stored);
    const session = parsed.success ? parsed.data : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (stored) await this.store.delete(this.transientKey("session", id));
      return null;
    }
    let storedProfile = await this.store.get<unknown>(profileKey(session.playerId));
    if (this.durableProfiles) {
      const durable = await this.durableProfiles.getUserProfile(session.playerId);
      if (!durable || durable.suspendedAt) {
        await this.store.delete(this.transientKey("session", id));
        return null;
      }
      storedProfile = this.fromDurableProfile(durable);
      await this.store.set(profileKey(session.playerId), storedProfile);
    }
    const profile = playerProfileSchema.safeParse(storedProfile);
    if (!profile.success) {
      await this.store.delete(this.transientKey("session", id));
      return null;
    }
    return { ...session, profile: profile.data };
  }

  async updateProfile(sessionId: string | undefined, update: ProfileUpdate): Promise<PlayerProfile | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    const profile: PlayerProfile = {
      ...session.profile,
      displayName: update.displayName.trim(),
      badgeId: update.badgeId,
      phone: update.phone,
      updatedAt: Date.now()
    };
    const synchronized = this.durableProfiles
      ? this.fromDurableProfile(await this.durableProfiles.upsertUserProfile({
          id: profile.id,
          email: profile.email,
          displayName: profile.displayName,
          badgeId: profile.badgeId,
          phone: profile.phone,
          now: new Date(profile.updatedAt)
        }))
      : profile;
    await this.store.set(profileKey(synchronized.id), synchronized);
    return synchronized;
  }

  async deleteSession(id?: string): Promise<void> {
    if (id) await this.store.delete(this.transientKey("session", id));
  }
}
