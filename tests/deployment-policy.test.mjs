import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSessionSecretAction,
  isConfirmedMissingWorker,
  parseInstanceStatus,
  parseSecretNames,
  parseSourceDeploymentIdentity,
  redactCloudflareOutput,
  validateGeneratedDeploymentIdentity,
} from "../scripts/deployment-policy.mjs";

test("a new unconfigured instance initializes its session secret exactly once", () => {
  assert.equal(decideSessionSecretAction({
    secretNames: [],
    instanceStatus: "unconfigured",
  }), "initialize");
  assert.equal(decideSessionSecretAction({
    secretNames: ["SESSION_ENCRYPTION_KEY"],
    instanceStatus: "unconfigured",
  }), "preserve");
});

test("an existing session secret is always preserved", () => {
  assert.equal(decideSessionSecretAction({
    secretNames: ["ANOTHER_SECRET", "SESSION_ENCRYPTION_KEY"],
    instanceStatus: "ready",
  }), "preserve");
});

test("a configured database without its encryption key fails closed", () => {
  assert.throws(() => decideSessionSecretAction({
    secretNames: [],
    instanceStatus: "ready",
  }), /SECURITY\.md/);
});

test("a secret query failure cannot be mistaken for a missing secret", () => {
  assert.throws(() => decideSessionSecretAction({
    secretNames: [],
    instanceStatus: "unconfigured",
    secretQuerySucceeded: false,
    workerConfirmedMissing: false,
  }), /部署已停止/);
  assert.equal(decideSessionSecretAction({
    secretNames: [],
    instanceStatus: "unconfigured",
    secretQuerySucceeded: false,
    workerConfirmedMissing: true,
  }), "initialize");
});

test("Wrangler JSON parsing accepts only the expected shapes", () => {
  assert.deepEqual(parseSecretNames([
    { name: "SESSION_ENCRYPTION_KEY", type: "secret_text" },
    { invalid: true },
  ]), ["SESSION_ENCRYPTION_KEY"]);
  assert.equal(parseInstanceStatus([{ results: [{ status: "unconfigured" }] }]), "unconfigured");
  assert.throws(() => parseSecretNames({}), /无法识别/);
  assert.throws(() => parseInstanceStatus([{ results: [] }]), /instance_config/);
});

test("only an explicit missing Worker response enables first-deploy recovery", () => {
  assert.equal(isConfirmedMissingWorker("Worker needle-drop-test does not exist"), true);
  assert.equal(isConfirmedMissingWorker("authentication failed"), false);
});

test("Cloudflare command output is redacted before it reaches logs", () => {
  const output = redactCloudflareOutput([
    "env.ALLOWED_EMAIL (\"owner@example.com\")",
    "env.ACCESS_TEAM_DOMAIN (\"https://personal.cloudflareaccess.com\")",
    `env.ACCESS_AUD (\"${"a".repeat(64)}\")`,
    "database_id = 11111111-2222-4333-8444-555555555555",
  ].join("\n"));

  assert.doesNotMatch(output, /owner@example\.com|personal\.cloudflareaccess\.com|a{64}|11111111-2222/);
  assert.match(output, /\[redacted/);
});

test("a private build cannot silently fall back to the public Worker identity", () => {
  const source = parseSourceDeploymentIdentity(`{
    "name": "isolated-worker",
    "d1_databases": [{
      "binding": "DB",
      "database_name": "isolated-db",
      "database_id": "11111111-2222-4333-8444-555555555555"
    }],
    "workflows": [{ "name": "isolated-workflow", "binding": "MUSIC_SYNC" }]
  }`);
  const generated = {
    name: "isolated-worker",
    d1_databases: [{ database_name: "isolated-db", database_id: source.databaseId }],
    workflows: [{ name: "isolated-workflow" }],
  };
  assert.doesNotThrow(() => validateGeneratedDeploymentIdentity(source, generated));
  assert.throws(
    () => validateGeneratedDeploymentIdentity(source, { ...generated, name: "production-worker" }),
    /错误实例/,
  );
  assert.throws(
    () => validateGeneratedDeploymentIdentity(source, {
      ...generated,
      d1_databases: [{ database_name: "isolated-db", database_id: "different" }],
    }),
    /错误数据库/,
  );
});
