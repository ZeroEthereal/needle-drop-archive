export const emailRuleNames = ["grey", "missing", "mismatch", "recovery"] as const;
export type EmailRuleName = (typeof emailRuleNames)[number];

export const emailRuleLabels: Record<EmailRuleName, string> = {
  grey: "变灰",
  missing: "消失",
  mismatch: "错配",
  recovery: "待召回",
};

export interface EmailNotificationSettings {
  enabled: boolean;
  notifySyncFailure: boolean;
  rules: Record<EmailRuleName, { checked: boolean; threshold: number }>;
}

export interface EmailNotificationSettingsResponse {
  settings: EmailNotificationSettings;
  available: boolean;
}

export function defaultEmailNotificationSettings(): EmailNotificationSettings {
  return {
    enabled: false,
    notifySyncFailure: true,
    rules: {
      grey: { checked: true, threshold: 1 },
      missing: { checked: false, threshold: 1 },
      mismatch: { checked: false, threshold: 1 },
      recovery: { checked: false, threshold: 1 },
    },
  };
}

export function validEmailThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export function parseEmailNotificationSettings(input: unknown): EmailNotificationSettings | undefined {
  const settings = objectRecord(input);
  const rules = objectRecord(settings?.rules);
  if (typeof settings?.enabled !== "boolean" || typeof settings.notifySyncFailure !== "boolean" || !rules) return;

  const parsed = defaultEmailNotificationSettings();
  parsed.enabled = settings.enabled;
  parsed.notifySyncFailure = settings.notifySyncFailure;
  for (const name of emailRuleNames) {
    const rule = objectRecord(rules[name]);
    if (typeof rule?.checked !== "boolean" || !validEmailThreshold(rule.threshold)) return;
    parsed.rules[name] = { checked: rule.checked, threshold: rule.threshold };
  }
  return parsed;
}

export function hasEmailNotificationRule(settings: EmailNotificationSettings): boolean {
  return settings.notifySyncFailure || emailRuleNames.some((name) => settings.rules[name].checked);
}
