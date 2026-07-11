import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedConnectorPayload {
  encryptedPayload: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export class ConnectorCryptoError extends Error {
  constructor(public readonly code: "CONNECTOR_CONFIGURATION_MISSING" | "CONNECTOR_CREDENTIAL_INVALID") {
    super(code);
  }
}

function encryptionKey() {
  const encoded = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!encoded) throw new ConnectorCryptoError("CONNECTOR_CONFIGURATION_MISSING");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new ConnectorCryptoError("CONNECTOR_CONFIGURATION_MISSING");
  }
  return key;
}

export function assertConnectorEncryptionConfigured() {
  encryptionKey();
}

export function encryptConnectorPayload(value: unknown, associatedData = ""): EncryptedConnectorPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    encryptedPayload: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: 1,
  };
}

export function decryptConnectorPayload<T>(payload: EncryptedConnectorPayload, associatedData = ""): T {
  try {
    if (payload.keyVersion !== 1) throw new Error("Unsupported key version");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(payload.iv, "base64"));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.encryptedPayload, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof ConnectorCryptoError) throw error;
    throw new ConnectorCryptoError("CONNECTOR_CREDENTIAL_INVALID");
  }
}
