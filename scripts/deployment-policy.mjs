export const SESSION_SECRET_NAME = "SESSION_ENCRYPTION_KEY";

export function redactCloudflareOutput(value) {
  return String(value ?? "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[redacted-id]")
    .replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted-email]")
    .replace(/https?:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?/gi, "[redacted-access-domain]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted-access-aud]")
    .replace(
      /(env\.(?:ALLOWED_EMAIL|ACCESS_TEAM_DOMAIN|ACCESS_AUD)\s*\()[^\r\n)]*(\))/g,
      "$1[redacted]$2",
    );
}

function requiredMatch(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`无法从 Wrangler 配置读取${label}，部署已停止。`);
  return match[1];
}

export function parseSourceDeploymentIdentity(text) {
  const d1Block = requiredMatch(
    text,
    /"d1_databases"\s*:\s*\[\s*\{([\s\S]*?)\}\s*\]/,
    "D1 binding",
  );
  const workflowBlock = requiredMatch(
    text,
    /"workflows"\s*:\s*\[\s*\{([\s\S]*?)\}\s*\]/,
    "Workflow binding",
  );
  return {
    name: requiredMatch(text, /^\s*"name"\s*:\s*"([^"]+)"/m, "Worker 名称"),
    databaseName: requiredMatch(d1Block, /"database_name"\s*:\s*"([^"]+)"/, "D1 名称"),
    databaseId: d1Block.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1],
    workflowName: requiredMatch(workflowBlock, /"name"\s*:\s*"([^"]+)"/, "Workflow 名称"),
  };
}

export function validateGeneratedDeploymentIdentity(source, generated) {
  const actual = {
    name: generated?.name,
    databaseName: generated?.d1_databases?.[0]?.database_name,
    databaseId: generated?.d1_databases?.[0]?.database_id,
    workflowName: generated?.workflows?.[0]?.name,
  };
  for (const key of ["name", "databaseName", "workflowName"]) {
    if (source[key] !== actual[key]) {
      throw new Error(`生产构建没有继承所选配置的 ${key}；为防止部署到错误实例，部署已停止。`);
    }
  }
  if (source.databaseId && source.databaseId !== actual.databaseId) {
    throw new Error("生产构建没有继承所选配置的 D1 ID；为防止连接错误数据库，部署已停止。");
  }
}

export function decideSessionSecretAction({
  secretNames,
  instanceStatus,
  secretQuerySucceeded = true,
  workerConfirmedMissing = false,
}) {
  if (!secretQuerySucceeded && !workerConfirmedMissing) {
    throw new Error("无法确认远程 Worker Secret 状态；为避免覆盖现有密钥，部署已停止。");
  }

  if (secretNames.includes(SESSION_SECRET_NAME)) return "preserve";
  if (instanceStatus !== "unconfigured") {
    throw new Error(
      "当前 D1 已包含正式实例配置，但 SESSION_ENCRYPTION_KEY 不存在。请按 SECURITY.md 的密钥恢复流程处理，部署不会自动生成新密钥。",
    );
  }

  return "initialize";
}

export function parseSecretNames(value) {
  if (!Array.isArray(value)) throw new Error("Wrangler 返回了无法识别的 Secret 列表。");
  return value
    .map((item) => item && typeof item === "object" && typeof item.name === "string" ? item.name : null)
    .filter(Boolean);
}

export function parseInstanceStatus(value) {
  if (!Array.isArray(value)) throw new Error("Wrangler 返回了无法识别的 D1 查询结果。");
  for (const batch of value) {
    const results = batch && typeof batch === "object" ? batch.results : undefined;
    if (!Array.isArray(results)) continue;
    for (const row of results) {
      if (row && typeof row === "object" && typeof row.status === "string") {
        return row.status;
      }
    }
  }
  throw new Error("D1 中缺少 instance_config 单例记录，部署已停止。");
}

export function isConfirmedMissingWorker(stderr) {
  return /worker.+(?:not found|does not exist)|no script named|code\s*=?\s*10090/i.test(stderr);
}
