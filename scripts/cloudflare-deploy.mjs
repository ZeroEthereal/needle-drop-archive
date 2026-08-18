import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SESSION_SECRET_NAME,
  decideSessionSecretAction,
  isConfirmedMissingWorker,
  parseInstanceStatus,
  parseSecretNames,
  parseSourceDeploymentIdentity,
  redactCloudflareOutput,
  validateGeneratedDeploymentIdentity,
} from "./deployment-policy.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const localVars = join(projectRoot, ".dev.vars");
const hiddenVars = join(projectRoot, ".dev.vars.deploy-hidden");
const privateConfig = join(projectRoot, "wrangler.private.jsonc");
const publicConfig = join(projectRoot, "wrangler.jsonc");
const generatedConfig = join(projectRoot, ".wrangler", "deploy", "config.json");
const clientBuild = join(projectRoot, "dist", "client");
const generatedWorkerConfig = join(projectRoot, "dist", "server", "wrangler.json");
const wranglerCli = join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

function printCaptured(result) {
  if (result.stdout) process.stdout.write(redactCloudflareOutput(result.stdout));
  if (result.stderr) process.stderr.write(redactCloudflareOutput(result.stderr));
}

function requireSuccess(result, label) {
  if (result.status === 0) return result;
  const detail = redactCloudflareOutput(
    [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  );
  throw new Error(`${label}失败${detail ? `：\n${detail}` : "。"}`);
}

function configArgs(configPath) {
  return ["--config", configPath];
}

async function selectConfig() {
  if (process.env.NEEDLE_DEPLOY_CONFIG) {
    const requested = resolve(projectRoot, process.env.NEEDLE_DEPLOY_CONFIG);
    if (requested !== publicConfig && requested !== privateConfig) {
      throw new Error("NEEDLE_DEPLOY_CONFIG 只能选择 wrangler.jsonc 或 wrangler.private.jsonc。");
    }
    if (!await exists(requested)) throw new Error("指定的 Wrangler 配置不存在。");
    return requested;
  }
  return await exists(privateConfig) ? privateConfig : publicConfig;
}

async function ensureBuild(configPath, useExistingBuild) {
  if (useExistingBuild) {
    if (!await exists(generatedConfig) || !await exists(clientBuild)) {
      throw new Error("没有找到完整生产构建。请先运行 npm run build，或改用 npm run deploy:full。");
    }
    return;
  }

  if (!process.env.npm_execpath) {
    throw new Error("请通过 npm run deploy:full 执行完整部署。");
  }
  const build = run(process.execPath, [process.env.npm_execpath, "run", "build"], {
    env: { ...process.env, CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: configPath },
  });
  requireSuccess(build, "生产构建");
}

async function verifyGeneratedConfig(configPath) {
  const source = parseSourceDeploymentIdentity(await readFile(configPath, "utf8"));
  const generated = JSON.parse(await readFile(generatedWorkerConfig, "utf8"));
  validateGeneratedDeploymentIdentity(source, generated);
}

function parseJsonOutput(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}返回了无法识别的 JSON，部署已停止。`);
  }
}

async function applyMigrations(configPath) {
  const result = run(process.execPath, [
    wranglerCli, "d1", "migrations", "apply", "DB", "--remote", ...configArgs(configPath),
  ], { capture: true });
  requireSuccess(result, "D1 migration");
  printCaptured(result);
}

function readInstanceStatus(configPath) {
  const result = run(process.execPath, [
    wranglerCli, "d1", "execute", "DB", "--remote", "--json",
    "--command", "SELECT status FROM instance_config WHERE id = 'primary' LIMIT 1",
    ...configArgs(configPath),
  ], { capture: true });
  requireSuccess(result, "实例状态检查");
  return parseInstanceStatus(parseJsonOutput(result.stdout, "实例状态检查"));
}

function readSecretState(configPath) {
  const result = run(process.execPath, [
    wranglerCli, "secret", "list", "--format", "json", ...configArgs(configPath),
  ], { capture: true });
  if (result.status === 0) {
    return {
      names: parseSecretNames(parseJsonOutput(result.stdout, "Secret 状态检查")),
      querySucceeded: true,
      workerConfirmedMissing: false,
    };
  }
  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    names: [],
    querySucceeded: false,
    workerConfirmedMissing: isConfirmedMissingWorker(detail),
  };
}

async function deploy(configPath, secretAction, dryRun) {
  const args = [wranglerCli, "deploy"];
  let tempDirectory;
  try {
    if (dryRun) args.push("--dry-run");
    if (secretAction === "initialize") {
      tempDirectory = await mkdtemp(join(tmpdir(), "needle-drop-secrets-"));
      const secretFile = join(tempDirectory, "secrets.json");
      await writeFile(
        secretFile,
        JSON.stringify({ [SESSION_SECRET_NAME]: randomBytes(32).toString("base64") }),
        { encoding: "utf8", mode: 0o600 },
      );
      args.push("--secrets-file", secretFile);
    }

    // vinext writes .wrangler/deploy/config.json during build. Wrangler follows
    // that generated configuration for deploy; CLOUDFLARE_CONFIG_PATH tells the
    // build which public/private source configuration it was generated from.
    const result = run(process.execPath, args, {
      env: { ...process.env, CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: configPath },
      capture: true,
    });
    requireSuccess(result, dryRun ? "Wrangler dry-run" : "Worker 部署");
    printCaptured(result);
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const useExistingBuild = process.argv.includes("--use-existing-build");
  const configPath = await selectConfig();

  if (!await exists(localVars) && await exists(hiddenVars)) await rename(hiddenVars, localVars);
  if (await exists(localVars) && await exists(hiddenVars)) {
    throw new Error(".dev.vars 与部署临时隐藏文件同时存在，请先人工确认后再部署。");
  }

  const hadLocalVars = await exists(localVars);
  try {
    if (hadLocalVars) await rename(localVars, hiddenVars);
    await ensureBuild(configPath, useExistingBuild && !dryRun);
    await verifyGeneratedConfig(configPath);

    if (dryRun) {
      await deploy(configPath, "preserve", true);
      return;
    }

    await applyMigrations(configPath);
    const instanceStatus = readInstanceStatus(configPath);
    const secretState = readSecretState(configPath);
    const secretAction = decideSessionSecretAction({
      secretNames: secretState.names,
      instanceStatus,
      secretQuerySucceeded: secretState.querySucceeded,
      workerConfirmedMissing: secretState.workerConfirmedMissing,
    });
    await deploy(configPath, secretAction, false);
    console.log(secretAction === "initialize"
      ? "部署完成：已为全新实例创建加密 Secret。"
      : "部署完成：现有加密 Secret 保持不变。");
  } finally {
    if (hadLocalVars && await exists(hiddenVars)) await rename(hiddenVars, localVars);
  }
}

await main();
