import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("login challenges and cookies stay server-side and out of API URLs", async () => {
  const [api, flows, sessions] = await Promise.all([
    source("worker/api.ts"),
    source("worker/auth-flows.ts"),
    source("worker/session-store.ts"),
  ]);
  assert.match(api, /POST.*\/api\/netease\/auth-flows|app\.post\("\/api\/netease\/auth-flows"/s);
  assert.match(api, /auth-flows\/:id\/poll/);
  assert.match(api, /auth-flows\/:id\/qr/);
  assert.doesNotMatch(api, /qr\/:key|param\("key"\)/);
  assert.match(flows, /challenge_ciphertext/);
  assert.match(flows, /encryptSecret\(challenge\.key/);
  assert.match(flows, /qrImageUrl: `\/api\/netease\/auth-flows\/\$\{id\}\/qr`/);
  assert.doesNotMatch(flows.match(/export interface PublicAuthFlow[\s\S]*?\n}/)?.[0] ?? "", /qrUrl/);
  assert.match(sessions, /AES-256-GCM/);
  assert.doesNotMatch(api, /ciphertext|nonce|MUSIC_U|cookie/i);
});

test("the binding transaction is version-guarded and clears old data only inside D1 batch", async () => {
  const binding = await source("worker/binding-runner.ts");
  assert.match(binding, /base_binding_version/);
  assert.match(binding, /binding_version = \?/);
  assert.match(binding, /env\.DB\.batch\(statements\)/);
  assert.match(binding, /DELETE FROM managed_songs/);
  assert.match(binding, /DELETE FROM songs/);
  assert.match(binding, /DELETE FROM sync_runs/);
  assert.match(binding, /results\[0\]\.meta\?\.changes/);
});

test("the schema separates active config, encrypted auth flows and pending bindings", async () => {
  const migration = await source("drizzle/0005_instance_playlist_binding.sql");
  assert.match(migration, /CREATE TABLE `instance_config`/);
  assert.match(migration, /CREATE TABLE `netease_auth_flows`/);
  assert.match(migration, /CREATE TABLE `pending_playlist_bindings`/);
  assert.match(migration, /`binding_version` integer/);
  assert.doesNotMatch(migration, /DELETE FROM (songs|managed_songs|sync_runs)/);
});
