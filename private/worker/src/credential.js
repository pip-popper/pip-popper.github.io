// PIP POPPER PRIVATE — the invitees' password, changeable from the manager tool (2026-11-22).
//
// Where the password lives:
//   - Nothing in R2 (the state until the first change): the Worker secret PRIVATE_PASSWORD, exactly as before.
//   - After a change: auth/private-password.json in the private R2 bucket. It holds only a check value,
//     never the password: HMAC-SHA256(SESSION_KEY, "pw-hash:" + salt + ":" + password) with a random salt.
//     Without SESSION_KEY (a Worker secret) the file alone cannot be used to find the password.
//     PRIVATE_PASSWORD is then ignored until the file is removed (see restore in admin.js).
// Immediate effect: the file is read on every entry and every session check (no cache), so a change applies to the
// very next request. Each change gets a new random id; it is the version written in the entry cookie, so every
// earlier cookie stops working at once.
// Fail closed: if the file cannot be read or is damaged, nobody enters (no silent fall back to the old password).
// HMAC purposes are kept apart by their label: "pw-hash" (this file), "check"/"version" (PRIVATE_PASSWORD),
// "session"/"admin-session" (cookies), "admin-check"/"admin-version" (administrator).
// The bucket has no public URL, audio is served only for songs in catalog.json, and cleanup only looks at audio/,
// so this file is never served or deleted by those paths.
import { b64u, fromB64u, hmac, sameBytes, secretMatches, secretVersion } from './common.js';

export const CREDENTIAL_KEY = 'auth/private-password.json';
export const MIN_PASSWORD = 8;

const checkValue = (env, salt, password) => hmac(env.SESSION_KEY, `pw-hash:${salt}:${password}`);

export async function loadCredential(env) {
  const object = await env.BUCKET.get(CREDENTIAL_KEY);            // an R2 error throws: entry fails closed
  if (!object) return null;
  const c = JSON.parse(await object.text());
  if (c?.format !== 1 || !/^[A-Za-z0-9_-]{16,}$/.test(c.salt ?? '') || !/^[A-Za-z0-9_-]{40,}$/.test(c.hash ?? '') || !/^[A-Za-z0-9_-]{16,}$/.test(c.id ?? ''))
    throw new Error('credential file is damaged');
  return c;
}
// cred: the result of loadCredential (null = the Worker secret is in use)
export async function memberPasswordMatches(env, input, cred) {
  if (!cred) return secretMatches(env, input, env.PRIVATE_PASSWORD, 'check');
  return sameBytes(fromB64u(cred.hash), await checkValue(env, cred.salt, input));
}
export const memberVersion = (env, cred) => cred ? `r-${cred.id}` : secretVersion(env, env.PRIVATE_PASSWORD, 'version');

export async function saveCredential(env, password) {
  const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const record = { format: 1, method: 'HMAC-SHA256 with SESSION_KEY, label pw-hash, random salt', salt, hash: b64u(await checkValue(env, salt, password)), id, changedAt: new Date().toISOString() };
  await env.BUCKET.put(CREDENTIAL_KEY, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  // read it back and check the new password against it before reporting success
  const back = await loadCredential(env);
  if (!back || back.id !== id || !await memberPasswordMatches(env, password, back)) throw new Error('credential check after saving failed');
  return { changedAt: back.changedAt };
}
export const removeCredential = env => env.BUCKET.delete(CREDENTIAL_KEY);
