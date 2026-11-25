import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_INIT_DATA_LENGTH = 16_384;
const ALLOWED_CLOCK_SKEW_SECONDS = 30;

export function telegramUsersFromEnv(env) {
  const configuredUsers = env.MINIAPP_USERS ?? env.TG_USER_ID ?? '';
  return new Set(configuredUsers.split(',').map((id) => id.trim()).filter(Boolean));
}

/** Return the authorized Telegram user ID, or null. Keep initData out of logs. */
export function verifyTelegramUser(initData, {
  botToken,
  allowedUserIds,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 300,
}) {
  if (!botToken || !allowedUserIds?.size) throw new Error('Telegram authentication is not configured');
  if (typeof initData !== 'string' || initData.length > MAX_INIT_DATA_LENGTH) return null;

  const fields = new Map();
  for (const [key, value] of new URLSearchParams(initData)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key) || /[\r\n]/.test(value) || fields.has(key)) return null;
    fields.set(key, value);
  }

  const hash = fields.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  fields.delete('hash');

  const checkString = [...fields.keys()].sort().map((key) => `${key}=${fields.get(key)}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const authDate = fields.get('auth_date');
  if (!authDate || !/^\d+$/.test(authDate)) return null;
  const age = nowSeconds - Number(authDate);
  if (!Number.isFinite(age) || age < -ALLOWED_CLOCK_SKEW_SECONDS || age > maxAgeSeconds) return null;

  let user;
  try {
    user = JSON.parse(fields.get('user') ?? 'null');
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) return null;
  return allowedUserIds.has(String(user.id)) ? String(user.id) : null;
}
