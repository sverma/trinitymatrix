import { describe, expect, it } from "vitest";
import { PostGameChatCipher } from "./chat-crypto";

const context = {
  messageId: "00000000-0000-4000-8000-000000000001",
  matchId: "00000000-0000-4000-8000-000000000002",
  authorUserId: "00000000-0000-4000-8000-000000000003",
  clientMessageId: "00000000-0000-4000-8000-000000000004"
};

describe("post-game chat field encryption", () => {
  it("round-trips AES-256-GCM ciphertext without retaining plaintext", () => {
    const cipher = new PostGameChatCipher(Buffer.alloc(32, 9).toString("base64"), 3);
    const encrypted = cipher.encrypt("Good game!", context);

    expect(encrypted.keyVersion).toBe(3);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain("Good game!");
    expect(cipher.decrypt(encrypted, context)).toBe("Good game!");
  });

  it("authenticates message ownership metadata and key versions", () => {
    const cipher = new PostGameChatCipher(Buffer.alloc(32, 5).toString("base64"), 2);
    const encrypted = cipher.encrypt("Well played", context);

    expect(() => cipher.decrypt(encrypted, { ...context, matchId: "00000000-0000-4000-8000-000000000099" })).toThrow();
    expect(() => new PostGameChatCipher(Buffer.alloc(32, 5).toString("base64"), 1).decrypt(encrypted, context))
      .toThrow("version 2");
  });
});
