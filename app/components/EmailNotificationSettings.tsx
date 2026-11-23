"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  emailRuleLabels, emailRuleNames, hasEmailNotificationRule, validEmailThreshold,
  type EmailNotificationSettings as EmailSettings, type EmailNotificationSettingsResponse, type EmailRuleName,
} from "../../lib/email-notifications";
import type { RequestOption } from "../api-client";

const settingsUrl = "/api/settings/email-notifications";

export default function EmailNotificationSettings({ request, onSaved }: {
  request: (options: RequestOption[]) => Promise<unknown>;
  onSaved: () => void;
}) {
  const [response, setResponse] = useState<EmailNotificationSettingsResponse>();
  const [draft, setDraft] = useState<EmailSettings>();
  const [thresholdInputs, setThresholdInputs] = useState<Partial<Record<EmailRuleName, string>>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const settings = draft ?? response?.settings;
  const edited = Boolean(draft) || Object.keys(thresholdInputs).length > 0;

  useEffect(() => {
    const controller = new AbortController();
    void request([{ url: settingsUrl, init: { signal: controller.signal } }]).then((data) => {
      if (!controller.signal.aborted) setResponse(data as EmailNotificationSettingsResponse);
    }).catch(() => {
      if (!controller.signal.aborted) setError("邮箱通知设置暂时无法加载。");
    });
    return () => controller.abort();
  }, [loadAttempt, request]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || !edited || saving) return;
    const next = { ...settings, rules: { ...settings.rules } };
    for (const name of emailRuleNames) {
      const threshold = Number(thresholdInputs[name] ?? next.rules[name].threshold);
      if (validEmailThreshold(threshold)) {
        next.rules[name] = { ...next.rules[name], threshold };
      } else if (next.enabled) {
        setError(`「${emailRuleLabels[name]}」的阈值必须是正整数。`);
        return;
      }
    }
    if (next.enabled && !hasEmailNotificationRule(next)) {
      setError("开启通知时至少选择一项规则。");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const saved = await request([{ url: settingsUrl, init: { method: "PUT", body: JSON.stringify(next) } }]);
      setResponse(saved as EmailNotificationSettingsResponse);
      setDraft(undefined);
      setThresholdInputs({});
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="glass-panel settings-panel" aria-labelledby="email-notifications-title">
      <header className="settings-panel-heading">
        <div>
          <h2 id="email-notifications-title">邮箱通知</h2>
          <p className="email-settings-hint">每天自动同步结束后检查一次。手动同步时不会发邮件。</p>
        </div>
        {response && settings ? (
          <label className="email-settings-switch">
            <span>启用</span>
            <input type="checkbox" role="switch" aria-label="启用邮箱通知" checked={settings.enabled}
              disabled={saving || (!response.available && !settings.enabled)}
              onChange={(event) => setDraft({ ...settings, enabled: event.target.checked })} />
          </label>
        ) : null}
      </header>
      {response && settings ? (
        <form className="email-settings-form" onSubmit={(event) => void save(event)}>
          {!response.available ? <p className="email-settings-error" role="alert">当前实例尚未配置邮件发送服务。</p> : null}
          <fieldset className="email-settings-rules" disabled={!settings.enabled || saving || !response.available}>
            <legend>提醒条件</legend>
            {emailRuleNames.map((name) => {
              const rule = settings.rules[name];
              return (
                <div className="email-settings-rule" key={name}>
                  <label>
                    <input type="checkbox" checked={rule.checked} onChange={(event) => setDraft({
                      ...settings, rules: { ...settings.rules, [name]: { ...rule, checked: event.target.checked } },
                    })} />
                    {emailRuleLabels[name]}
                  </label>
                  <label className="email-threshold">
                    <input type="number" inputMode="numeric" min={1} step={1} max={Number.MAX_SAFE_INTEGER} required
                      aria-label={`${emailRuleLabels[name]}提醒阈值`}
                      value={thresholdInputs[name] ?? rule.threshold}
                      onChange={(event) => setThresholdInputs({ ...thresholdInputs, [name]: event.target.value })} />
                    <span>首</span>
                  </label>
                </div>
              );
            })}
            <p className="email-settings-hint">达到阈值时发送完整的待找回名单。「待召回」总数按歌曲去重。</p>
            <label className="email-settings-failure">
              <input type="checkbox" checked={settings.notifySyncFailure}
                onChange={(event) => setDraft({ ...settings, notifySyncFailure: event.target.checked })} />
              自动同步失败时通知
            </label>
          </fieldset>
          {error ? <p className="email-settings-error" role="alert">{error}</p> : null}
          <div className="email-settings-actions">
            <button type="button" className="quiet-button" disabled={!edited || saving}
              onClick={() => { setDraft(undefined); setThresholdInputs({}); setError(""); }}>放弃修改</button>
            <button type="submit" className="primary-button" disabled={!edited || saving || (settings.enabled && !response.available)}>
              {saving ? "正在保存" : "保存设置"}
            </button>
          </div>
        </form>
      ) : error ? (
        <div className="email-settings-form">
          <p className="email-settings-error" role="alert">{error}</p>
          <button type="button" className="quiet-button" onClick={() => { setError(""); setLoadAttempt(loadAttempt + 1); }}>重新加载</button>
        </div>
      ) : <p className="email-settings-hint" role="status">正在加载邮箱通知设置…</p>}
    </section>
  );
}
