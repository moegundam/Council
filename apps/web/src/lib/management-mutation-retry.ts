export interface ManagementMutationRetryToken {
  intent: string;
  idempotencyKey: string;
}

export class ManagementMutationRetrySignature {
  private signingKey: Promise<CryptoKey> | null = null;

  async forPayload(operation: string, payload: unknown): Promise<string> {
    this.signingKey ??= globalThis.crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    ) as Promise<CryptoKey>;
    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      await this.signingKey,
      new TextEncoder().encode(JSON.stringify([operation, payload]))
    );
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

export class ManagementMutationRetryOwnership {
  private readonly keys = new Map<string, string>();

  acquire(
    operation: string,
    resourceId: string,
    signature: string,
    createKey: () => string
  ): ManagementMutationRetryToken {
    const intent = JSON.stringify([operation, resourceId, signature]);
    const idempotencyKey = this.keys.get(intent) ?? createKey();
    this.keys.set(intent, idempotencyKey);
    return { intent, idempotencyKey };
  }

  clear(token: ManagementMutationRetryToken): void {
    if (this.keys.get(token.intent) === token.idempotencyKey) this.keys.delete(token.intent);
  }
}
