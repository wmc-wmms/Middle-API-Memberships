/**
 * Credenciales oficiales separadas de usuarios API. AES-GCM cifra el secret; revision evita sobrescrituras y fingerprint vincula cada envío a su identidad.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { dirname } from 'node:path';

import { z } from 'zod';

import { digest, audit, fail } from './security.mjs';

import { LiveAudax, AudaxError } from './audax.mjs';

import { AUDAX_URLS } from './config.mjs';



export async function settingsKey(config) {

  if (config.encryptionKey) {

    if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey)) throw new Error('CONFIG_ENCRYPTION_KEY debe tener 64 caracteres hexadecimales');

    return Buffer.from(config.encryptionKey, 'hex');

  }

  if (config.databaseUrl) throw new Error('Configurá CONFIG_ENCRYPTION_KEY compartida entre API y worker para cifrar credenciales de Audax');

  await mkdir(dirname(config.encryptionKeyFile), { recursive: true });

  try { await writeFile(config.encryptionKeyFile, randomBytes(32).toString('hex'), { flag:'wx', mode:0o600 }); }

  catch (error) { if (error.code !== 'EEXIST') throw error; }

  const key = (await readFile(config.encryptionKeyFile, 'utf8')).trim();

  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('La clave de cifrado local no es válida');

  return Buffer.from(key, 'hex');

}

export class AudaxSettings {

  constructor(db, config, key, fetcher = fetch) { Object.assign(this, { db, config, key, fetcher }); this.cached = null; }

  encrypt(secret, fingerprint) {

    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);

    cipher.setAAD(Buffer.from(`audax:${this.config.environment}:${fingerprint}`));

    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

    return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.');

  }

  decrypt(encoded, fingerprint) {

    try {

      const [iv, tag, encrypted] = encoded.split('.').map(s => Buffer.from(s, 'base64'));

      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);

      decipher.setAAD(Buffer.from(`audax:${this.config.environment}:${fingerprint}`)); decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

    } catch { throw fail(503, 'credential_decryption_failed', 'No se pudo descifrar el secret. Restaurá la clave de cifrado o volvé a guardar las credenciales.'); }

  }

  async record(db = this.db) { return (await db.query('SELECT * FROM audax_settings WHERE id=1')).rows[0]; }

  async status() {

    const r = await this.record();

    return { environment:this.config.environment, mode:'live', local_preview:!!this.config.localPreview, base_url:AUDAX_URLS[this.config.environment], token_url:this.config.audaxTokenUrl,

      client_id:r.client_id, scope:r.scope, secret_configured:!!r.secret_encrypted, configured:!!(r.client_id && r.scope && r.secret_encrypted),

      revision:r.revision, verified_at:r.verified_at, last_error:r.last_error, updated_at:r.updated_at };

  }

  async save(input, actor) {

    if(this.config.localPreview)throw fail(409,'prod_preview','PROD local está vacío y bloqueado para envíos. Habilitá PostgreSQL y HTTPS antes de configurar sus credenciales.');

    const body = z.strictObject({ client_id:z.string().trim().min(1).max(200), scope:z.string().trim().min(1).max(1500),

      client_secret:z.string().max(8192).optional(), revision:z.number().int().nonnegative() }).parse(input);

    const fingerprint = digest(JSON.stringify([this.config.environment, body.client_id, body.scope]));

    await this.db.transaction(async tx => {

      const row = (await tx.query('SELECT * FROM audax_settings WHERE id=1 FOR UPDATE')).rows[0];

      if (row.revision !== body.revision) throw fail(409, 'settings_changed', 'La configuración cambió. Recargá antes de guardar.');

      if (row.client_id && row.client_id !== body.client_id && !body.client_secret) throw fail(400, 'new_secret_required', 'Al cambiar el client ID también debés ingresar su secret');

      if (row.fingerprint && row.fingerprint !== fingerprint) {

        const pending = (await tx.query("SELECT id FROM operations WHERE audax_mode='live' AND status IN ('queued','sending','submitted','unknown') LIMIT 1")).rows[0];

        if (pending) throw fail(409, 'pending_operations', 'Hay procesos pendientes o inciertos. Resolvelos antes de cambiar la identidad de Audax.');

      }

      const secret = body.client_secret || (row.secret_encrypted ? this.decrypt(row.secret_encrypted, row.fingerprint) : '');

      if (!secret) throw fail(400, 'secret_required', 'Ingresá el client secret de Audax');

      await tx.query(`UPDATE audax_settings SET client_id=$1,scope=$2,secret_encrypted=$3,fingerprint=$4,

        revision=revision+1,verified_at=NULL,last_error=NULL,updated_at=now() WHERE id=1`, [body.client_id,body.scope,this.encrypt(secret,fingerprint),fingerprint]);

      await audit(tx, actor, 'audax.settings_saved', this.config.environment);

    });

    this.cached = null;

    return this.status();

  }

  async adapter(expectedFingerprint) {

    const r = await this.record();

    if (!r.client_id || !r.scope || !r.secret_encrypted) throw new AudaxError('Falta configurar client ID, secret y scope de Audax', { retryable:true });

    if (expectedFingerprint && r.fingerprint !== expectedFingerprint) throw new AudaxError('La identidad Audax cambió; no se envió la operación');

    if (this.cached?.revision !== r.revision) {

      this.cached = { revision:r.revision, adapter:new LiveAudax({ ...this.config, environment:this.config.environment, audaxBaseUrl:AUDAX_URLS[this.config.environment],

        audaxClientId:r.client_id, audaxClientSecret:this.decrypt(r.secret_encrypted,r.fingerprint), audaxScope:r.scope }, this.fetcher) };

    }

    return { adapter:this.cached.adapter, record:r };

  }

  async test(actor) {

    const { adapter, record } = await this.adapter();

    try {

      // Fresh token is required: a cached token must not mask an expired/revoked secret.

      adapter.token = null;

      const result = await adapter.request('GET', 'GetBusiness');

      if (!Array.isArray(result.body)) throw new AudaxError('GetBusiness devolvió un formato no documentado');

      const r = await this.db.query('UPDATE audax_settings SET verified_at=now(),last_error=NULL WHERE id=1 AND revision=$1 RETURNING id', [record.revision]);

      if (!r.rows.length) throw fail(409, 'settings_changed', 'La configuración cambió durante la prueba. Volvé a probar.');

      await audit(this.db,actor,'audax.connection_verified',this.config.environment);

      return { ...(await this.status()), business_count:result.body.length };

    } catch (error) {

      if (error.statusCode === 409) throw error;

      const message = connectionError(error);

      await this.db.query('UPDATE audax_settings SET verified_at=NULL,last_error=$2 WHERE id=1 AND revision=$1',[record.revision,message]);

      throw fail(400,'audax_connection_failed',message);

    }

  }

  async bootstrap() {

    const row = await this.record();

    if (!row.secret_encrypted && this.config.audaxClientId && this.config.audaxClientSecret && this.config.audaxScope) {

      await this.save({client_id:this.config.audaxClientId,client_secret:this.config.audaxClientSecret,scope:this.config.audaxScope,revision:row.revision},'bootstrap');

    }

  }

}

export function connectionError(error) {

  if (error.status === 401 || error.status === 403 || error.status === 400) return `Audax rechazó el acceso (HTTP ${error.status}). Revisá client ID, secret, scope y permisos.`;

  if (error.status === 429) return 'Audax limitó las solicitudes (HTTP 429). Reintentá más tarde.';

  if (error.status) return `Audax respondió HTTP ${error.status}. No se reemplazaron los catálogos locales.`;

  return 'No se pudo completar la conexión con Audax. Revisá las credenciales y la conectividad del servidor.';

}

export class ManagedAudax {

  constructor(settings) { this.settings = settings; }

  async isReady() { const r=await this.settings.record();return !!(r.secret_encrypted && r.client_id && r.scope && !this.settings.config.localPreview); }

  async submit(op) { const {adapter}=await this.settings.adapter(op.connection_fingerprint);return adapter.submit(op); }

  async poll(id) { const {adapter}=await this.settings.adapter();return adapter.poll(id); }

  async upgrades() { const {adapter}=await this.settings.adapter();return adapter.upgrades(); }

}

