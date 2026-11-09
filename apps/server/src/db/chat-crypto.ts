import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedChatBody = Readonly<{
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}>;

export type ChatEncryptionContext = Readonly<{
  messageId: string;
  matchId: string;
  authorUserId: string;
  clientMessageId: string;
}>;

function additionalAuthenticatedData(context: ChatEncryptionContext, keyVersion: number): Buffer {
  return Buffer.from(
    `trinitymatrix:post-game-chat:v1\n${keyVersion}\n${context.messageId}\n${context.matchId}\n${context.authorUserId}\n${context.clientMessageId}`,
    "utf8"
  );
}

export class PostGameChatCipher {
  private readonly key: Buffer;

  constructor(base64Key: string, readonly keyVersion = 1) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== base64Key) {
      throw new Error("CHAT_ENCRYPTION_KEY must be the canonical base64 encoding of exactly 32 bytes.");
    }
    if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 32_767) {
      throw new Error("CHAT_ENCRYPTION_KEY_VERSION must be an integer between 1 and 32767.");
    }
  }

  encrypt(plaintext: string, context: ChatEncryptionContext): EncryptedChatBody {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(additionalAuthenticatedData(context, this.keyVersion));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: this.keyVersion };
  }

  decrypt(encrypted: EncryptedChatBody, context: ChatEncryptionContext): string {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new Error(`No post-game chat decryption key is configured for version ${encrypted.keyVersion}.`);
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, encrypted.iv);
    decipher.setAAD(additionalAuthenticatedData(context, encrypted.keyVersion));
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
  }
}
