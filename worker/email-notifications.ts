import { Buffer } from "node:buffer";
import { EmailMessage } from "cloudflare:email";
import {
  defaultEmailNotificationSettings, emailRuleLabels, emailRuleNames,
  type EmailNotificationSettings, type EmailRuleName,
} from "../lib/email-notifications";
import { countRecoverySongs, listRecoveryEmailPage } from "../lib/sync/repository";
import { getSetting, putSetting } from "../lib/sync/storage";
import type { Env } from "./env";
import { syncHistoryOutcome } from "./sync-history";

const settingsKey = "email_notifications";
export const emailAttemptKeyPrefix = "email_notification_batch:";
const recoveryPageSize = 200;
const maxInlineBytes = 64 * 1024;
const maxAttachmentBytes = 17 * 1024 * 1024;

interface NotificationState {
  settings: EmailNotificationSettings;
  notified: EmailRuleName[];
  ruleVersions: Partial<Record<EmailRuleName, string>>;
}

async function readState(db: D1Database) {
  const value = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(settingsKey).first<string>("value");
  const state: NotificationState = value === null
    ? { settings: defaultEmailNotificationSettings(), notified: [], ruleVersions: {} }
    : JSON.parse(value) as NotificationState;
  return { value, state };
}

async function writeState(db: D1Database, previous: string | null, state: NotificationState) {
  const value = JSON.stringify(state);
  if (value === previous) return value;
  const query = previous === null
    ? db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(settingsKey, value)
    : db.prepare(`UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE key = ? AND value = ?`).bind(value, settingsKey, previous);
  const result = await query.run();
  if (!result.success) throw new Error("Could not save email notification state");
  return result.meta.changes === 1 ? value : null;
}

function emailDelivery(env: Env) {
  const sender = env.NOTIFICATION_EMAIL_FROM?.trim();
  const recipient = env.ALLOWED_EMAIL?.trim().toLowerCase();
  const emailPattern = /^[^@<>\s,;]+@[a-z\d.-]+\.[a-z\d]+$/i;
  if (!env.NOTIFICATION_EMAIL || !sender || !recipient || !emailPattern.test(sender) || !emailPattern.test(recipient)) return;
  return { binding: env.NOTIFICATION_EMAIL, sender, recipient };
}

export async function readEmailNotificationSettings(env: Env) {
  const { state } = await readState(env.DB);
  return { settings: state.settings, available: emailNotificationsAvailable(env) };
}

export function emailNotificationsAvailable(env: Env) {
  return Boolean(emailDelivery(env));
}

export async function saveEmailNotificationSettings(db: D1Database, settings: EmailNotificationSettings) {
  const version = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { state, value } = await readState(db);
    const ruleVersions = { ...state.ruleVersions };
    for (const name of emailRuleNames) {
      const previous = state.settings.rules[name];
      const next = settings.rules[name];
      if (state.settings.enabled !== settings.enabled || previous.checked !== next.checked || previous.threshold !== next.threshold) {
        ruleVersions[name] = version;
      }
    }
    const notified = state.notified.filter((name) => ruleVersions[name] === state.ruleVersions[name]);
    if (await writeState(db, value, { settings, ruleVersions, notified })) return true;
  }
  return false;
}

type RecoveryCounts = Record<EmailRuleName, number>;

function oneLine(value: string) {
  return value.replace(/[\r\n]+/g, " ");
}

async function completeRecoveryList(db: D1Database, total: number) {
  const lines: string[] = [];
  let after = "";
  while (lines.length < total) {
    const page = await listRecoveryEmailPage(db, after, recoveryPageSize);
    if (!page.length) throw new Error("Could not read the complete recovery list");
    for (const song of page) {
      const original = `${oneLine(song.title)} ／ ${oneLine(song.artists.join("、") || "未知歌手")}`;
      const contexts = song.contexts.map(({ name, type }) => `${oneLine(name)}（${emailRuleLabels[type]}）`).join("、");
      const changed = song.contexts.some(({ type }) => type === "mismatch") &&
        (song.observed_title !== null || song.observed_artists !== null);
      const observed = changed ? `\n   原资料：${original}\n   当前资料：${oneLine(song.observed_title ?? song.title)} ／ ${oneLine((song.observed_artists ?? song.artists).join("、") || "未知歌手")}` : "";
      lines.push(`${lines.length + 1}. ${original}\n   ${contexts}${observed}`);
    }
    after = page[page.length - 1].id;
  }
  if (lines.length !== total) throw new Error("Recovery list changed during notification preparation");
  return lines.join("\n\n");
}

function base64Part(data: string | Buffer) {
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  return buffer.toString("base64").replace(/.{76}(?=.)/g, "$&\r\n");
}

async function recoveryAttachment(list: string) {
  if (Buffer.byteLength(list) <= maxAttachmentBytes) {
    return { data: Buffer.from(list), name: "needle-drop-recovery.txt", type: "text/plain; charset=UTF-8" };
  }
  const stream = new Response(list).body?.pipeThrough(new CompressionStream("gzip"));
  const data = Buffer.from(await new Response(stream).arrayBuffer());
  if (data.byteLength > maxAttachmentBytes) throw new Error("Recovery list exceeds the email size limit");
  return { data, name: "needle-drop-recovery.txt.gz", type: "application/gzip" };
}

async function buildEmail(sender: string, recipient: string, subject: string, summary: string, list = "") {
  const headers = [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${sender.split("@")[1]}>`,
    "MIME-Version: 1.0",
  ];
  const textHeaders = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  if (Buffer.byteLength(list) <= maxInlineBytes) {
    const body = list ? `${summary}\n\n${list}` : summary;
    return new EmailMessage(sender, recipient, [...headers, ...textHeaders, "", base64Part(body), ""].join("\r\n"));
  }
  const attachment = await recoveryAttachment(list);
  const boundary = `needle-drop-${crypto.randomUUID()}`;
  const message = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, ...textHeaders, "", base64Part(`${summary}\n\n完整待找回名单见附件。`),
    `--${boundary}`, `Content-Type: ${attachment.type}`, "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${attachment.name}"`, "", base64Part(attachment.data),
    `--${boundary}--`, ""].join("\r\n");
  return new EmailMessage(sender, recipient, message);
}

async function acceptRules(db: D1Database, stateAtSend: NotificationState, triggered: EmailRuleName[]) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { state, value } = await readState(db);
    const unchanged = triggered.filter((name) => state.ruleVersions[name] === stateAtSend.ruleVersions[name]);
    const notified = [...new Set([...state.notified, ...unchanged])];
    if (await writeState(db, value, { ...state, notified })) return;
  }
  throw new Error("Could not record the accepted email rules");
}

export function logNotificationFailure(batchId: string, error: unknown) {
  const errorCode = error instanceof Error && "code" in error && typeof error.code === "string" && /^E_[A-Z_]+$/.test(error.code)
    ? error.code : "NOTIFICATION_FAILED";
  console.error({ event: "scheduled_email_failed", batchId, errorCode });
}

export async function checkScheduledEmail(env: Env, batchId: string, dispatchFailed = false) {
  if (!batchId.startsWith("scheduled-")) return;
  const delivery = emailDelivery(env);
  if (!delivery) return;
  const db = env.DB;
  const { state, value } = await readState(db);
  if (!state.settings.enabled || value === null) return;

  const attemptKey = emailAttemptKeyPrefix + batchId;
  if (await getSetting(db, attemptKey)) return;
  const batch = await db.prepare(`SELECT status, playlist_count FROM sync_batches
    WHERE id = ? AND trigger = 'scheduled'`).bind(batchId).first<{ status: string; playlist_count: number }>();
  if (batch?.status !== (dispatchFailed ? "failed" : "running")) return;
  const tasks = await db.prepare(`SELECT playlist_id, playlist_name, status FROM sync_playlist_tasks
    WHERE batch_id = ? ORDER BY list_order, playlist_id`).bind(batchId)
    .all<{ playlist_id: string; playlist_name: string; status: string }>();
  if (!tasks.success) throw new Error("Could not read scheduled batch tasks");
  const { successful, failedPlaylists } = syncHistoryOutcome({
    status: dispatchFailed ? "failed" : "success", playlist_count: batch.playlist_count,
  }, tasks.results);

  const day = batchId.slice("scheduled-".length);
  let subject = "";
  let summary = "";
  let list = "";
  let triggered: EmailRuleName[] = [];
  let currentValue = value;
  if (!successful) {
    if (!state.settings.notifySyncFailure) return;
    subject = "拾针｜自动同步失败";
    const sources = failedPlaylists.map(({ name }) => `- ${oneLine(name)}`).join("\n");
    summary = `${day} 的自动同步未完成。${sources ? `\n\n未完成的监控项\n${sources}` : ""}\n\n请到拾针的「同步状态」查看详情。`;
  } else {
    const checked = emailRuleNames.filter((name) => state.settings.rules[name].checked);
    if (!checked.length) return;
    const result = await countRecoverySongs(db);
    if (!result) throw new Error("Could not count recovery songs");
    const counts: RecoveryCounts = { grey: result.grey, missing: result.missing, mismatch: result.mismatch, recovery: result.total };
    const reached = checked.filter((name) => counts[name] >= state.settings.rules[name].threshold);
    const notified = state.notified.filter((name) => reached.includes(name));
    triggered = reached.filter((name) => !notified.includes(name));
    if (notified.length !== state.notified.length) {
      const updated = await writeState(db, value, { ...state, notified });
      if (updated === null) return;
      currentValue = updated;
    }
    if (triggered.length) {
      subject = "拾针｜待找回歌曲提醒";
      const causes = triggered.map((name) => `${emailRuleLabels[name]} ${counts[name]} 首（阈值 ${state.settings.rules[name].threshold}）`);
      summary = `${day} 自动同步完成。\n\n触发条件：${causes.join("、")}。\n共 ${counts.recovery} 首待找回歌曲，变灰 ${counts.grey} 首、消失 ${counts.missing} 首、错配 ${counts.mismatch} 首。`;
      list = await completeRecoveryList(db, counts.recovery);
    }
  }

  const message = subject ? await buildEmail(delivery.sender, delivery.recipient, subject, summary, list) : undefined;
  // Claim before calling the external binding, even if its delivery result is later lost.
  const claim = await db.prepare(`INSERT OR IGNORE INTO settings (key, value)
    SELECT ?, ? FROM settings WHERE key = ? AND value = ?`)
    .bind(attemptKey, JSON.stringify(message ? "sending" : "checked"), settingsKey, currentValue).run();
  if (!claim.success) throw new Error("Could not claim scheduled email batch");
  if (claim.meta.changes !== 1 || !message) return;
  try {
    await delivery.binding.send(message);
  } catch (error) {
    await putSetting(db, attemptKey, "failed").catch((saveError) => logNotificationFailure(batchId, saveError));
    throw error;
  }
  if (triggered.length) await acceptRules(db, state, triggered);
  await putSetting(db, attemptKey, "sent");
}
