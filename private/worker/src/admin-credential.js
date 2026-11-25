// PIP POPPER PRIVATE — the administrator password, changeable from the manager tool (2026-11-25).
// Same model as the invitees' password (credential.js):
//   - Nothing in R2: the Worker secret ADMIN_PASSWORD, exactly as before.
//   - After a change: auth/admin-password.json in the private R2 bucket, holding only a check value
//     HMAC-SHA256(SESSION_KEY, "admin-pw-hash:" + salt + ":" + password). ADMIN_PASSWORD is then not accepted.
//   - Each change has a new random id, used as the admin cookie version: every earlier admin session ends at once.
//   - Fail closed: a damaged file lets no administrator in (invitees are not affected).
// Recovery: the manager's "Cloudflareの管理者パスワードに戻す" (needs the current password), or — if it is forgotten —
// delete auth/admin-password.json in the Cloudflare dashboard (R2 → pip-popper-private-audio); ADMIN_PASSWORD works again.
import { b64u, fromB64u, hmac, sameBytes, secretMatches, secretVersion } from './common.js';

export const ADMIN_CREDENTIAL_KEY = 'auth/admin-password.json';
export const MIN_ADMIN_PASSWORD = 12;

const checkValue = (env, salt, password) => hmac(env.SESSION_KEY, `admin-pw-hash:${salt}:${password}`);

export async function loadAdminCredential(env) {
  const object = await env.BUCKET.get(ADMIN_CREDENTIAL_KEY);       // an R2 error throws: admin entry fails closed
  if (!object) return null;
  const c = JSON.parse(await object.text());
  if (c?.format !== 1 || !/^[A-Za-z0-9_-]{16,}$/.test(c.salt ?? '') || !/^[A-Za-z0-9_-]{40,}$/.test(c.hash ?? '') || !/^[A-Za-z0-9_-]{16,}$/.test(c.id ?? ''))
    throw new Error('admin credential file is damaged');
  return c;
}
export async function adminPasswordMatches(env, input, cred) {
  if (cred === undefined) cred = await loadAdminCredential(env);
  if (!cred) return secretMatches(env, input, env.ADMIN_PASSWORD, 'admin-check');
  return sameBytes(fromB64u(cred.hash), await checkValue(env, cred.salt, input));
}
export const adminVersion = async env => { const c = await loadAdminCredential(env); return c ? `r-${c.id}` : secretVersion(env, env.ADMIN_PASSWORD, 'admin-version'); };

export async function saveAdminCredential(env, password) {
  const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const record = { format: 1, method: 'HMAC-SHA256 with SESSION_KEY, label admin-pw-hash, random salt', salt, hash: b64u(await checkValue(env, salt, password)), id, changedAt: new Date().toISOString() };
  await env.BUCKET.put(ADMIN_CREDENTIAL_KEY, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  const back = await loadAdminCredential(env);                      // read back and check before reporting success
  if (!back || back.id !== id || !await adminPasswordMatches(env, password, back)) throw new Error('admin credential check after saving failed');
  return { changedAt: back.changedAt };
}
export const removeAdminCredential = env => env.BUCKET.delete(ADMIN_CREDENTIAL_KEY);
