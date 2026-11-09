import { describe, expect, it, vi } from "vitest";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON
} from "@simplewebauthn/server";
import {
  AdminPasskeyConflictError,
  AdminPasskeyService,
  type AdminPasskeyCredential,
  type AdminPasskeyRepository,
  type AdminWebAuthnAdapter
} from "./admin-passkeys";
import { MemoryStateStore } from "./persistence";

const userId = "11111111-1111-4111-8111-111111111111";
const session = {
  id: "22222222-2222-4222-8222-222222222222",
  playerId: userId,
  profile: { email: "admin@example.com", displayName: "Admin" }
};
const credentialId = "credential-aaaaaa";

class MemoryPasskeyRepository implements AdminPasskeyRepository {
  readonly credentials: AdminPasskeyCredential[] = [];
  readonly recoveryHashes = new Set<string>();
  authenticationCount = 0;

  async listCredentials(): Promise<readonly AdminPasskeyCredential[]> {
    return this.credentials;
  }

  async findCredential(_userId: string, id: string): Promise<AdminPasskeyCredential | null> {
    return this.credentials.find((credential) => credential.id === id) ?? null;
  }

  async hasUnusedRecoveryCode(_userId: string, hash: Buffer): Promise<boolean> {
    return this.recoveryHashes.has(hash.toString("hex"));
  }

  async enrollCredential(input: Parameters<AdminPasskeyRepository["enrollCredential"]>[0]): Promise<void> {
    if (input.authorization === "bootstrap" && this.credentials.length > 0) {
      throw new AdminPasskeyConflictError("already enrolled");
    }
    if (typeof input.authorization === "object") {
      const hash = input.authorization.recoveryCodeHash.toString("hex");
      if (!this.recoveryHashes.delete(hash)) throw new AdminPasskeyConflictError("used recovery code");
    }
    this.credentials.push(input.credential);
    if (input.initialRecoveryCodeHashes) {
      this.recoveryHashes.clear();
      for (const hash of input.initialRecoveryCodeHashes) this.recoveryHashes.add(hash.toString("hex"));
    }
  }

  async recordAuthentication(input: Parameters<AdminPasskeyRepository["recordAuthentication"]>[0]): Promise<void> {
    const index = this.credentials.findIndex((credential) => credential.id === input.credentialId);
    if (index < 0 || this.credentials[index]!.counter !== input.previousCounter) {
      throw new AdminPasskeyConflictError("counter changed");
    }
    this.credentials[index] = { ...this.credentials[index]!, counter: input.newCounter };
    this.authenticationCount += 1;
  }

  async replaceRecoveryCodes(_userId: string, hashes: readonly Buffer[]): Promise<void> {
    this.recoveryHashes.clear();
    for (const hash of hashes) this.recoveryHashes.add(hash.toString("hex"));
  }
}

function fakeWebAuthn() {
  const generateRegistrationOptions = vi.fn(async () => ({ challenge: "registration-challenge-123456" }));
  const verifyRegistrationResponse = vi.fn(async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: credentialId,
        publicKey: Uint8Array.from({ length: 32 }, (_, index) => index),
        counter: 0,
        transports: ["internal"]
      },
      credentialBackedUp: true
    }
  }));
  const generateAuthenticationOptions = vi.fn(async () => ({ challenge: "authentication-challenge-123456" }));
  const verifyAuthenticationResponse = vi.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 }
  }));
  return {
    adapter: {
      generateRegistrationOptions,
      verifyRegistrationResponse,
      generateAuthenticationOptions,
      verifyAuthenticationResponse
    } as unknown as AdminWebAuthnAdapter,
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse
  };
}

function registrationResponse(id = credentialId): RegistrationResponseJSON {
  return { id } as RegistrationResponseJSON;
}

function authenticationResponse(id = credentialId): AuthenticationResponseJSON {
  return { id } as AuthenticationResponseJSON;
}

describe("administrator passkeys", () => {
  it("allows bootstrap only before the first credential and withholds access until recovery codes are acknowledged", async () => {
    const repository = new MemoryPasskeyRepository();
    const store = new MemoryStateStore();
    const webauthn = fakeWebAuthn();
    const service = new AdminPasskeyService(repository, store, {
      rpName: "TrinityMatrix Administration",
      rpId: "admin.example.com",
      origin: "https://admin.example.com",
      bootstrapSecret: "correct-bootstrap-secret-with-entropy",
      webauthn: webauthn.adapter
    });

    await expect(service.registrationOptions({
      session,
      deviceName: "Primary phone",
      bootstrapCode: "wrong-bootstrap-secret"
    })).rejects.toThrow("bootstrap code is incorrect");

    const request = await service.registrationOptions({
      session,
      deviceName: "Primary phone",
      bootstrapCode: "correct-bootstrap-secret-with-entropy"
    });
    const verified = await service.verifyRegistration({
      session,
      requestId: request.requestId,
      response: registrationResponse()
    });

    expect(verified.recoveryCodes).toHaveLength(10);
    expect(verified.recoveryAcknowledgementToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(verified.accessToken).toBeUndefined();
    expect(await service.hasAccess(session.id, session.playerId, undefined)).toBe(false);
    const accessToken = await service.acknowledgeRecoveryCodes(session, verified.recoveryAcknowledgementToken!);
    expect(await service.hasAccess(session.id, session.playerId, accessToken)).toBe(true);
    await expect(service.acknowledgeRecoveryCodes(session, verified.recoveryAcknowledgementToken!)).rejects.toThrow("expired");
    await expect(service.registrationOptions({
      session: { ...session, id: "33333333-3333-4333-8333-333333333333" },
      deviceName: "Second device",
      bootstrapCode: "correct-bootstrap-secret-with-entropy"
    })).rejects.toThrow("recovery code");
  });

  it("binds authentication challenges and short-lived elevation to the exact email session", async () => {
    const repository = new MemoryPasskeyRepository();
    repository.credentials.push({
      id: credentialId,
      publicKey: Uint8Array.from({ length: 32 }, (_, index) => index),
      counter: 0,
      transports: ["internal"],
      deviceName: "Primary phone",
      backedUp: true
    });
    const webauthn = fakeWebAuthn();
    const service = new AdminPasskeyService(repository, new MemoryStateStore(), {
      rpName: "TrinityMatrix Administration",
      rpId: "admin.example.com",
      origin: "https://admin.example.com",
      bootstrapSecret: "correct-bootstrap-secret-with-entropy",
      webauthn: webauthn.adapter
    });
    const request = await service.authenticationOptions(session);
    await expect(service.verifyAuthentication({
      session: { ...session, id: "33333333-3333-4333-8333-333333333333" },
      requestId: request.requestId,
      response: authenticationResponse()
    })).rejects.toThrow("expired");

    const retry = await service.authenticationOptions(session);
    const token = await service.verifyAuthentication({
      session,
      requestId: retry.requestId,
      response: authenticationResponse()
    });
    expect(await service.hasAccess(session.id, session.playerId, token)).toBe(true);
    expect(repository.authenticationCount).toBe(1);
    expect(repository.credentials[0]!.counter).toBe(1);
    await expect(service.verifyAuthentication({
      session,
      requestId: retry.requestId,
      response: authenticationResponse()
    })).rejects.toThrow("expired");
  });

  it("consumes a recovery code only after a replacement passkey verifies", async () => {
    const repository = new MemoryPasskeyRepository();
    const webauthn = fakeWebAuthn();
    const service = new AdminPasskeyService(repository, new MemoryStateStore(), {
      rpName: "TrinityMatrix Administration",
      rpId: "admin.example.com",
      origin: "https://admin.example.com",
      bootstrapSecret: "correct-bootstrap-secret-with-entropy",
      webauthn: webauthn.adapter
    });
    const first = await service.registrationOptions({
      session,
      deviceName: "Primary phone",
      bootstrapCode: "correct-bootstrap-secret-with-entropy"
    });
    const enrollment = await service.verifyRegistration({ session, requestId: first.requestId, response: registrationResponse() });
    const recoveryCode = enrollment.recoveryCodes![0]!;
    webauthn.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: "credential-bbbbbb",
          publicKey: Uint8Array.from({ length: 32 }, (_, index) => 31 - index),
          counter: 0,
          transports: ["hybrid"]
        },
        credentialBackedUp: false
      }
    });
    const recoveredSession = { ...session, id: "33333333-3333-4333-8333-333333333333" };
    const recovery = await service.registrationOptions({
      session: recoveredSession,
      deviceName: "Replacement laptop",
      recoveryCode
    });
    await service.verifyRegistration({
      session: recoveredSession,
      requestId: recovery.requestId,
      response: registrationResponse("credential-bbbbbb")
    });
    expect(repository.credentials).toHaveLength(2);
    await expect(service.registrationOptions({
      session: { ...session, id: "44444444-4444-4444-8444-444444444444" },
      deviceName: "Attacker device",
      recoveryCode
    })).rejects.toThrow("unused recovery code");
  });
});
