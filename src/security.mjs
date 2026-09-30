/**
 * Autenticación y auditoría. Secrets de clientes y contraseñas se guardan con hash; tokens opacos. No registrar secretos ni datos personales en logs.
 */
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(value, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(value, encoded) {
  const [salt, hex] = encoded.split(':');
  const actual = await scrypt(value, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function fail(statusCode, code, message, details) {
  return Object.assign(new Error(message), { statusCode, code, details });
}
export async function bootstrapAdmin(db, config) {
  const exists = (await db.query('SELECT id FROM admins LIMIT 1')).rows.length;
  if (!exists) {
    if (!config.adminUsername || !config.adminPassword) throw new Error('Configurá ADMIN_USERNAME y ADMIN_PASSWORD para crear el administrador inicial');
    await db.query('INSERT INTO admins (id,username,password_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [randomUUID(), config.adminUsername, await hashPassword(config.adminPassword)]);
  }
}
export async function audit(db, actor, action, target, metadata = {}) {
  await db.query('INSERT INTO audit_events (actor,action,target,metadata) VALUES ($1,$2,$3,$4::jsonb)',
    [actor, action, target, JSON.stringify(metadata)]);
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
