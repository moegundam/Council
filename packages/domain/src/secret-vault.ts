import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

function decodeBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted secret format.");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new Error("Invalid encrypted secret format.");
  }
  return decoded;
}

export class SecretVault {
  private readonly key: Buffer;
  private readonly fingerprintKey: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("Secret vault key must be exactly 32 bytes.");
    this.key = Buffer.from(key);
    this.fingerprintKey = createHmac("sha256", this.key)
      .update("council-secret-vault-fingerprint-key-v1")
      .digest();
  }

  encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${nonce.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt(value: string): string {
    const [version, nonceValue, tagValue, ciphertextValue] = value.split(".");
    if (value.split(".").length !== 4 || version !== "v1" || !nonceValue || !tagValue || !ciphertextValue) {
      throw new Error("Invalid encrypted secret format.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, decodeBase64Url(nonceValue, 12));
    decipher.setAuthTag(decodeBase64Url(tagValue, 16));
    return Buffer.concat([
      decipher.update(decodeBase64Url(ciphertextValue)),
      decipher.final()
    ]).toString("utf8");
  }

  fingerprint(context: string, value: string): string {
    const normalizedContext = context.trim();
    if (!normalizedContext || normalizedContext.length > 200) throw new Error("Fingerprint context is invalid.");
    const digest = createHmac("sha256", this.fingerprintKey)
      .update(normalizedContext, "utf8")
      .update("\0")
      .update(value, "utf8")
      .digest("hex");
    return `hmac-sha256:v1:${digest}`;
  }
}
