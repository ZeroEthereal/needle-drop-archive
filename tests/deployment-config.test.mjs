import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("current schema and production Access configuration are independent", async () => {
  const [config, access, schema] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../worker/access.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_current_schema.sql", import.meta.url), "utf8"),
  ]);
  assert.match(access, /env\.ALLOWED_EMAIL/);
  assert.match(access, /jwtVerify\(token, jwks/);
  assert.doesNotMatch(config, /"(?:ALLOWED_EMAIL|ACCESS_TEAM_DOMAIN|ACCESS_AUD)"\s*:/);
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 11);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM songs").get().n, 0);
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
  assert.doesNotMatch(setupScript, /d1 export|Desktop backup|backupDirectory/);
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
