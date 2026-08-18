import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret, generateEncryptionKey } from "../worker/secrets.ts";

test("encrypts NetEase session values with a fresh AES-GCM nonce", async () => {
  const env = { SESSION_ENCRYPTION_KEY: generateEncryptionKey() };
  const first = await encryptSecret("MUSIC_U=secret-cookie", env);
  const second = await encryptSecret("MUSIC_U=secret-cookie", env);

  assert.notEqual(first.ciphertext, "MUSIC_U=secret-cookie");
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(await decryptSecret(first, env), "MUSIC_U=secret-cookie");
  assert.equal(await decryptSecret(second, env), "MUSIC_U=secret-cookie");
});

test("rejects an encryption key with the wrong length", async () => {
  await assert.rejects(
    encryptSecret("secret", { SESSION_ENCRYPTION_KEY: btoa("too-short") }),
    /32-byte key/,
  );
});
