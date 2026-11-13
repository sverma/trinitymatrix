import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { AuthService, MockEmailOtpSender, ResendEmailOtpSender, profileUpdateSchema, type DurableProfileStore } from "./auth";
import { MemoryStateStore } from "./persistence";

const options = { otpSecret: "unit-test-otp-secret-value", fixedCode: "123456" };

afterEach(() => vi.unstubAllGlobals());

describe("email authentication and profile persistence", () => {
  it("restores an email-linked profile and session through service restarts", async () => {
    const store = new MemoryStateStore();
    const first = new AuthService(new MockEmailOtpSender(), store, options);
    const challengeId = await first.requestOtp("Asha@Example.com");
    const persistedChallenge = await store.get<Record<string, unknown>>(`auth:challenge:${challengeId}`);
    expect(persistedChallenge).not.toHaveProperty("code");
    expect(persistedChallenge?.codeHash).toMatch(/^[a-f0-9]{64}$/);

    const restarted = new AuthService(new MockEmailOtpSender(), store, options);
    const session = await restarted.verifyOtp(challengeId, "123456", "Asha");
    expect(session?.profile).toMatchObject({
      email: "asha@example.com",
      displayName: "Asha",
      badgeId: "rookie",
      phone: null
    });

    const profile = await restarted.updateProfile(session!.id, {
      displayName: "Asha V",
      badgeId: "strategist",
      phone: { countryCode: "+91", nationalNumber: "9876543210" }
    });
    expect(profile).toMatchObject({ displayName: "Asha V", badgeId: "strategist" });

    const restartedAgain = new AuthService(new MockEmailOtpSender(), store, options);
    await expect(restartedAgain.getSession(session!.id)).resolves.toMatchObject({
      playerId: session!.playerId,
      profile: {
        displayName: "Asha V",
        badgeId: "strategist",
        phone: { countryCode: "+91", nationalNumber: "9876543210" }
      }
    });

    const nextChallenge = await restartedAgain.requestOtp("asha@example.com");
    const nextSession = await restartedAgain.verifyOtp(nextChallenge, "123456", "Ignored new name");
    expect(nextSession?.playerId).toBe(session!.playerId);
    expect(nextSession?.profile.displayName).toBe("Asha V");
  });

  it("sends real-provider email requests with an idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sender = new ResendEmailOtpSender("re_test", "TrinityMatrix <login@example.com>");

    await sender.send("player@example.com", "654321", "00000000-0000-4000-8000-000000000001");

    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer re_test",
        "Idempotency-Key": "00000000-0000-4000-8000-000000000001"
      })
    }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ to: ["player@example.com"], subject: expect.stringContaining("654321") });
  });

  it("reports structured provider errors without dumping an unstructured response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      name: "validation_error",
      message: "The sender address is invalid."
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const sender = new ResendEmailOtpSender("re_test", "TrinityMatrix <login@example.com>");

    await expect(sender.send(
      "player@example.com",
      "654321",
      "00000000-0000-4000-8000-000000000001"
    )).rejects.toThrow("request (400): validation_error: The sender address is invalid");
  });

  it("removes a challenge when the email provider rejects delivery", async () => {
    const store = new MemoryStateStore();
    const send = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const auth = new AuthService({ send }, store, options);

    await expect(auth.requestOtp("player@example.com")).rejects.toThrow("provider unavailable");
    const challengeId = String(send.mock.calls[0]![2]);
    await expect(store.get(`auth:challenge:${challengeId}`)).resolves.toBeNull();
  });

  it("does not allow a successfully verified challenge to be reused", async () => {
    const store = new MemoryStateStore();
    const auth = new AuthService(new MockEmailOtpSender(), store, options);
    const challengeId = await auth.requestOtp("player@example.com");

    await expect(auth.verifyOtp(challengeId, "123456", "Player")).resolves.not.toBeNull();
    await expect(auth.verifyOtp(challengeId, "123456", "Player")).resolves.toBeNull();
  });

  it("locks a challenge after five failed guesses", async () => {
    const store = new MemoryStateStore();
    const auth = new AuthService(new MockEmailOtpSender(), store, {
      ...options,
      stateEpoch: "production-v1"
    });
    const challengeId = await auth.requestOtp("player@example.com");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.verifyOtp(challengeId, "000000", "Player")).resolves.toBeNull();
    }
    await expect(store.get(`auth:challenge:${challengeId}`)).resolves.toBeNull();
    await expect(store.get(`auth:challenge:production-v1:${challengeId}`)).resolves.toMatchObject({
      failedAttempts: 5
    });
    await expect(auth.verifyOtp(challengeId, "123456", "Player")).resolves.toBeNull();
  });

  it("atomically consumes a correct challenge only once under concurrent verification", async () => {
    const store = new MemoryStateStore();
    const auth = new AuthService(new MockEmailOtpSender(), store, options);
    const challengeId = await auth.requestOtp("player@example.com");

    const results = await Promise.all(Array.from(
      { length: 12 },
      () => auth.verifyOtp(challengeId, "123456", "Player")
    ));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("retires only transient mock authentication state when the auth epoch changes", async () => {
    const store = new MemoryStateStore();
    const mockAuth = new AuthService(new MockEmailOtpSender(), store, options);
    const mockChallenge = await mockAuth.requestOtp("player@example.com");
    const mockSession = await mockAuth.verifyOtp(mockChallenge, "123456", "Original player");
    expect(mockSession).not.toBeNull();

    const resendEpoch = new AuthService(new MockEmailOtpSender(), store, {
      ...options,
      stateEpoch: "resend-2026-08-28"
    });

    await expect(resendEpoch.getSession(mockSession!.id)).resolves.toBeNull();
    await expect(resendEpoch.verifyOtp(mockChallenge, "123456", "Original player")).resolves.toBeNull();

    const resendChallenge = await resendEpoch.requestOtp("player@example.com");
    const resendSession = await resendEpoch.verifyOtp(resendChallenge, "123456", "Ignored replacement name");
    expect(resendSession?.playerId).toBe(mockSession!.playerId);
    expect(resendSession?.profile).toMatchObject({
      email: "player@example.com",
      displayName: "Original player"
    });

    // Stable identity data is deliberately not epoch-prefixed.
    await expect(store.get(`auth:profile:${mockSession!.playerId}`)).resolves.toMatchObject({
      email: "player@example.com",
      displayName: "Original player"
    });
  });

  it("rejects unsafe auth epoch tokens", () => {
    expect(() => new AuthService(new MockEmailOtpSender(), new MemoryStateStore(), {
      ...options,
      stateEpoch: "staging:*"
    })).toThrow("AUTH_STATE_EPOCH");
  });

  it("validates an optional ISD-coded phone as one E.164-sized number", () => {
    expect(profileUpdateSchema.safeParse({
      displayName: "Player",
      badgeId: "rookie",
      phone: { countryCode: "+91", nationalNumber: "9876543210" }
    }).success).toBe(true);
    expect(profileUpdateSchema.safeParse({
      displayName: "Player",
      badgeId: "rookie",
      phone: { countryCode: "+999", nationalNumber: "12345678901234" }
    }).success).toBe(false);
  });

  it.each(["model@ai.trinitymatrix.invalid", "  Model@AI.TrinityMatrix.Invalid  "])(
    "prevents an AI identity from receiving even a mock OTP", async (email) => {
      const store = new MemoryStateStore();
      const set = vi.spyOn(store, "set");
      const send = vi.fn();
      const auth = new AuthService({ send }, store, options);

      await expect(auth.requestOtp(email)).rejects.toThrow("AI player identities cannot sign in");
      expect(send).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    }
  );

  it("rejects and retires an old cached OTP challenge for an AI identity", async () => {
    const store = new MemoryStateStore();
    const auth = new AuthService(new MockEmailOtpSender(), store, { ...options, stateEpoch: "ai-v1" });
    const challengeId = "00000000-0000-4000-8000-000000000011";
    const email = "model@ai.trinitymatrix.invalid";
    const key = `auth:challenge:ai-v1:${challengeId}`;
    await store.set(key, {
      id: challengeId,
      email,
      codeHash: createHmac("sha256", options.otpSecret).update(`${challengeId}\n${email}\n123456`).digest("hex"),
      expiresAt: Date.now() + 60_000,
      failedAttempts: 0
    });
    const consume = vi.spyOn(store, "consumeChallenge");
    await expect(auth.verifyOtp(challengeId, "123456", "Impersonator")).resolves.toBeNull();
    expect(consume).not.toHaveBeenCalled();
    await expect(store.get(key)).resolves.toBeNull();
  });

  it("also refuses a reserved AI identity returned by atomic challenge consumption", async () => {
    const store = new MemoryStateStore();
    const auth = new AuthService(new MockEmailOtpSender(), store, options);
    const id = await auth.requestOtp("human@example.com");
    const challenge = (await store.get<Record<string, unknown>>(`auth:challenge:${id}`))!;
    vi.spyOn(store, "consumeChallenge").mockResolvedValue({ status: "verified", value: {
      ...challenge, email: "model@ai.trinitymatrix.invalid"
    } });
    await expect(auth.verifyOtp(id, "123456", "Impersonator")).resolves.toBeNull();
  });

  it("invalidates a forged cached session for an AI profile without consulting a durable override", async () => {
    const store = new MemoryStateStore();
    const sessionId = "00000000-0000-4000-8000-000000000021";
    const playerId = "00000000-0000-4000-8000-000000000022";
    const now = Date.now();
    await store.set(`auth:session:${sessionId}`, { id: sessionId, playerId, expiresAt: now + 60_000 });
    await store.set(`auth:profile:${playerId}`, {
      id: playerId, email: "model@ai.trinitymatrix.invalid", displayName: "AI Player",
      badgeId: "strategist", phone: null, createdAt: now, updatedAt: now
    });
    const durable: DurableProfileStore = { upsertUserProfile: vi.fn(), getUserProfile: vi.fn() };
    const auth = new AuthService(new MockEmailOtpSender(), store, options, durable);
    await expect(auth.getSession(sessionId)).resolves.toBeNull();
    expect(durable.getUserProfile).not.toHaveBeenCalled();
    await expect(store.get(`auth:session:${sessionId}`)).resolves.toBeNull();
  });

  it("rejects durable AI profiles even if a forged cached profile looks human", async () => {
    const store = new MemoryStateStore();
    const sessionId = "00000000-0000-4000-8000-000000000031";
    const playerId = "00000000-0000-4000-8000-000000000032";
    const now = Date.now();
    const key = `auth:session:ai-v1:${sessionId}`;
    await store.set(key, { id: sessionId, playerId, expiresAt: now + 60_000 });
    await store.set(`auth:profile:${playerId}`, {
      id: playerId, email: "human@example.com", displayName: "Human Player",
      badgeId: "rookie", phone: null, createdAt: now, updatedAt: now
    });
    const durable: DurableProfileStore = {
      upsertUserProfile: vi.fn(),
      getUserProfile: vi.fn().mockResolvedValue({
        id: playerId, email: "model@ai.trinitymatrix.invalid", displayName: "AI Player",
        badgeId: "strategist", phone: null, createdAt: new Date(now), updatedAt: new Date(now)
      })
    };
    const auth = new AuthService(new MockEmailOtpSender(), store, { ...options, stateEpoch: "ai-v1" }, durable);
    await expect(auth.getSession(sessionId)).resolves.toBeNull();
    await expect(store.get(key)).resolves.toBeNull();
  });
});
