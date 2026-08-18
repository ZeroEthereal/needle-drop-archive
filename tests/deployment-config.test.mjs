import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("the free-plan Cron Trigger starts the durable music sync Workflow", async () => {
  const [config, entrypoint] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(config, /"crons"\s*:\s*\["17 19 \* \* \*"\]/);
  assert.doesNotMatch(config, /"schedules"\s*:/);
  assert.match(entrypoint, /async scheduled\(/);
  assert.match(
    entrypoint,
    /MUSIC_SYNC\.create\(\{ params: \{ source: "scheduled" \} \}\)/,
  );
});

test("email notifications are removed without removing Access email authentication", async () => {
  const [config, access, env, api, runner, storage, component, initialMigration, removalMigration] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../worker/access.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/env.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/sync-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sync/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/MusicVault.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_eminent_betty_ross.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_remove_email_notifications.sql", import.meta.url), "utf8"),
  ]);

  const runtime = [config, access, env, api, runner, storage, component].join("\n");
  assert.doesNotMatch(
    runtime,
    /RESEND|EMAIL_TO|RESEND_FROM|notification_events|\/api\/notifications|emailStatus|邮件通知/i,
  );
  assert.match(access, /env\.ALLOWED_EMAIL/);
  assert.match(access, /jwtVerify\(token, jwks/);
  assert.doesNotMatch(config, /"(?:ALLOWED_EMAIL|ACCESS_TEAM_DOMAIN|ACCESS_AUD)"\s*:/);
  assert.match(removalMigration, /DROP TABLE IF EXISTS `notification_events`/);

  const database = new DatabaseSync(":memory:");
  database.exec(initialMigration);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS total FROM notification_events").get().total,
    0,
  );
  database.exec(removalMigration);
  assert.throws(() => database.prepare("SELECT * FROM notification_events").all());
  assert.equal(database.prepare("SELECT COUNT(*) AS total FROM songs").get().total, 0);
  database.close();
});

test("the public Wrangler template is safe for Deploy to Cloudflare", async () => {
  const [config, packageJson, deployScript, setupScript, bootstrapScript, readme, gitignore] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/cloudflare-deploy.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/setup-cloudflare.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/bootstrap-cloudflare.ps1", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);

  assert.match(config, /"keep_vars"\s*:\s*true/);
  assert.match(config, /"preview_urls"\s*:\s*false/);
  assert.doesNotMatch(config, /"database_id"\s*:/);
  assert.doesNotMatch(config, /00000000-0000-4000-8000-000000000000/);
  assert.match(packageJson, /wrangler d1 migrations apply DB --remote/);
  assert.match(deployScript, /randomBytes\(32\)/);
  assert.match(deployScript, /wranglerCli, "d1", "migrations", "apply", "DB", "--remote"/);
  assert.match(deployScript, /wranglerCli, "secret", "list", "--format", "json"/);
  assert.match(deployScript, /await rm\(tempDirectory, \{ recursive: true, force: true \}\)/);
  assert.match(deployScript, /verifyGeneratedConfig\(configPath\)/);
  assert.doesNotMatch(setupScript, /D:\\dev/i);
  assert.ok(setupScript.indexOf("npm ci") < setupScript.indexOf("wrangler whoami"));
  assert.match(setupScript, /-ReuseExisting/);
  assert.match(setupScript, /Remote D1 backup created on the Desktop/);
  assert.match(setupScript, /CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH\s*=\s*\$privateConfig/);
  assert.match(bootstrapScript, /Test-Path -LiteralPath \$configPath/);
  assert.match(bootstrapScript, /wrangler d1 list --json/);
  assert.match(gitignore, /wrangler\.private\.jsonc/);
  assert.match(gitignore, /\.dev\.vars\.deploy-hidden/);
  assert.match(
    readme,
    /https:\/\/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/ZeroEthereal\/needle-drop-archive/,
  );
  assert.doesNotMatch(readme, /候选|两个不同的北京时间自然日/);
});
