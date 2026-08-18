import type { Env } from "./env";

export interface EncryptedValue {
  ciphertext: string;
  nonce: string;
  keyVersion: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function importKey(env: Pick<Env, "SESSION_ENCRYPTION_KEY">): Promise<CryptoKey> {
  if (!env.SESSION_ENCRYPTION_KEY) {
    throw new Error("SESSION_ENCRYPTION_KEY is not configured");
  }
  const raw = base64ToBytes(env.SESSION_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) {
    throw new Error("SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(
  plaintext: string,
  env: Pick<Env, "SESSION_ENCRYPTION_KEY">,
): Promise<EncryptedValue> {
  const key = await importKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, encoded);
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    nonce: bytesToBase64(nonce),
    keyVersion: 1,
  };
}

export async function decryptSecret(
  encrypted: EncryptedValue,
  env: Pick<Env, "SESSION_ENCRYPTION_KEY">,
): Promise<string> {
  if (encrypted.keyVersion !== 1) throw new Error("Unsupported session key version");
  const key = await importKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encrypted.nonce) },
    key,
    base64ToBytes(encrypted.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export function generateEncryptionKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}
