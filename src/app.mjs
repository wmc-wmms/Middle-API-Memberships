/**
 * Servidor HTTP: sesión administrativa, OAuth de clientes, rutas y panel. Las operaciones se persisten aquí y el worker las ejecuta independientemente.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { randomToken, digest, hashPassword, verifyPassword, fail, audit, bootstrapAdmin } from './security.mjs';
import { clientSchema, ALL_SCOPES } from './validation.mjs';
import { enqueue, getOperation, publicStatus } from './operations.mjs';
import { validateClientCatalog } from './catalogs.mjs';
import { registerAdminRoutes } from './admin-routes.mjs';
const j = JSON.stringify;
const uuid = z.uuid();
function clientView(c) {
  return { id: c.id, name: c.name, company_name: c.company_name, email: c.email, client_id: c.client_id,
    active: c.active, business_ids: c.business_ids, plan_ids: c.plan_ids, business_plan_pairs:c.business_plan_pairs, scopes: c.scopes,
    created_at: c.created_at, updated_at: c.updated_at };
}
export async function buildApp({ db, config, gateway, settings = null, catalogs = null, logger = false }) {
  await bootstrapAdmin(db, config);
  const dummyHash = await hashPassword(randomToken());
  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024, requestTimeout: 30000,
    routerOptions: { caseSensitive: false, ignoreTrailingSlash: true } });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    reply.header('Cache-Control', 'no-store');
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'validation_error', message: 'Revisá los datos enviados', details: error.issues });
    const status = error.statusCode || 500;
    if (status >= 500) app.log.error({ code: error.code || 'internal_error' }, 'Error interno');
    reply.code(status).send({ error: status >= 500 ? 'internal_error' : error.code || 'request_error',
      message: status >= 500 ? 'No se pudo completar la solicitud' : error.message,
      ...(status < 500 && error.details ? { details: error.details } : {}) });
  });
  const cookieName = `audax_admin_${config.environment}`;
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/', maxAge: 28800 };
  function checkOrigin(req) {
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) throw fail(403, 'origin_rejected', 'Origen no permitido');
  }
  async function admin(req) {
    const token = req.cookies[cookieName];
    if (!token) throw fail(401, 'unauthorized', 'Iniciá sesión');
    const session = (await db.query(`SELECT s.*,a.username FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`, [digest(token)])).rows[0];
    if (!session) throw fail(401, 'unauthorized', 'La sesión venció');
    req.admin = session;
    if (!['GET','HEAD'].includes(req.method)) {
      checkOrigin(req);
      if (typeof req.headers['x-csrf-token'] !== 'string' || digest(req.headers['x-csrf-token']) !== session.csrf_hash) throw fail(403, 'csrf_invalid', 'Volvé a iniciar sesión para continuar');
    }
  }
  function integration(scope) {
    return async req => {
      const token = /^Bearer ([A-Za-z0-9_-]{30,200})$/i.exec(req.headers.authorization || '')?.[1];
      if (!token) throw fail(401, 'invalid_token', 'Se requiere un token Bearer válido');
      const record = (await db.query(`SELECT c.*,t.scopes AS token_scopes FROM access_tokens t JOIN clients c ON c.id=t.client_id
        WHERE t.token_hash=$1 AND t.expires_at>now() AND t.environment=$2 AND c.active=true`, [digest(token), config.environment])).rows[0];
      if (!record) throw fail(401, 'invalid_token', 'Token vencido, revocado o de otro ambiente');
      if (!record.token_scopes.includes(scope) || !record.scopes.includes(scope)) throw fail(403, 'insufficient_scope', `Se requiere ${scope}`);
      req.client = record;
    };
  }
  registerAdminRoutes(app,{db,config,settings,catalogs,admin});
  app.get('/health', async () => ({ status: 'ok', environment: config.environment }));
  app.get('/ready', async (_req, reply) => {
    const r = (await db.query('SELECT last_seen FROM worker_health WHERE id=1')).rows[0];
    const ready = r && Date.now() - new Date(r.last_seen).valueOf() < 120000;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'worker_unavailable' });
  });
  app.get('/public/config', async () => ({ environment: config.environment, mode: config.mode, use_catalogs:config.useCatalogs,local_preview:!!config.localPreview,portal_urls:{test:config.testPortalUrl,prod:config.prodPortalUrl} }));
  app.post('/admin/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    checkOrigin(req);
    const body = z.strictObject({ username: z.string().min(1).max(120), password: z.string().min(1).max(1024) }).parse(req.body);
    const record = (await db.query('SELECT * FROM admins WHERE username=$1', [body.username])).rows[0];
    if (!(await verifyPassword(body.password, record?.password_hash || dummyHash)) || !record) throw fail(401, 'invalid_credentials', 'Usuario o contraseña incorrectos');
    const token = randomToken(), csrf = randomToken();
    await db.transaction(async tx => {
      await tx.query('DELETE FROM admin_sessions WHERE expires_at<now()');
      await tx.query('INSERT INTO admin_sessions (token_hash,admin_id,csrf_hash,expires_at) VALUES ($1,$2,$3,$4)', [digest(token), record.id, digest(csrf), new Date(Date.now() + 28800000)]);
      await audit(tx, record.username, 'admin.login', record.id);
    });
    reply.setCookie(cookieName, token, cookieOptions);
    return { username: record.username, csrf_token: csrf, environment: config.environment };
  });
  app.get('/admin/session', { preHandler: admin }, async req => ({ username: req.admin.username, environment: config.environment, mode: config.mode, scopes: ALL_SCOPES }));
  app.post('/admin/logout', { preHandler: admin }, async (req, reply) => {
    await db.query('DELETE FROM admin_sessions WHERE token_hash=$1', [req.admin.token_hash]);
    reply.clearCookie(cookieName, { path: '/' }); return { ok: true };
  });
  app.post('/admin/change-password', { preHandler: admin }, async (req, reply) => {
    const data = z.strictObject({ current_password: z.string().max(1024), new_password: z.string().min(16).max(1024) }).parse(req.body);
    const record = (await db.query('SELECT * FROM admins WHERE id=$1', [req.admin.admin_id])).rows[0];
    if (!await verifyPassword(data.current_password, record.password_hash)) throw fail(403, 'invalid_password', 'Contraseña actual incorrecta');
    const passwordHash = await hashPassword(data.new_password);
    await db.transaction(async tx => {
      await tx.query('UPDATE admins SET password_hash=$2 WHERE id=$1', [record.id, passwordHash]);
      await tx.query('DELETE FROM admin_sessions WHERE admin_id=$1', [record.id]);
      await audit(tx, record.username, 'admin.password_changed', record.id);
    });
    reply.clearCookie(cookieName, { path: '/' }); return { ok: true };
  });
  app.get('/admin/clients', { preHandler: admin }, async () => (await db.query('SELECT * FROM clients ORDER BY created_at DESC')).rows.map(clientView));
  app.post('/admin/clients', { preHandler: admin }, async (req, reply) => {
    const body = clientSchema.parse(req.body), id = randomUUID();
    const clientId = `audax_${config.environment}_${randomUUID().replaceAll('-', '')}`, secret = randomToken();
    const encoded = await hashPassword(secret);
    const row = await db.transaction(async tx => {
      await validateClientCatalog(tx,body,config);
      const r = await tx.query(`INSERT INTO clients (id,name,company_name,email,client_id,secret_hash,active,business_ids,plan_ids,scopes,business_plan_pairs)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb) RETURNING *`,
      [id, body.name, body.company_name, body.email, clientId, encoded, body.active, j(body.business_ids), j(body.plan_ids), j(body.scopes),j(body.business_plan_pairs)]);
      await audit(tx, req.admin.username, 'client.created', id); return r.rows[0];
    });
    return reply.code(201).send({ ...clientView(row), client_secret: secret, environment: config.environment });
  });
  app.put('/admin/clients/:id', { preHandler: admin }, async req => {
    const id = uuid.parse(req.params.id), body = clientSchema.parse(req.body);
    return db.transaction(async tx => {
      await validateClientCatalog(tx,body,config);
      const r = await tx.query(`UPDATE clients SET name=$2,company_name=$3,email=$4,active=$5,business_ids=$6::jsonb,
        plan_ids=$7::jsonb,scopes=$8::jsonb,business_plan_pairs=$9::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, body.name, body.company_name, body.email, body.active, j(body.business_ids), j(body.plan_ids), j(body.scopes),j(body.business_plan_pairs)]);
      if (!r.rows.length) throw fail(404, 'not_found', 'Usuario no encontrado');
      await tx.query('DELETE FROM access_tokens WHERE client_id=$1', [id]);
      await audit(tx, req.admin.username, 'client.updated', id);
      return clientView(r.rows[0]);
    });
  });
  app.delete('/admin/clients/:id', { preHandler: admin }, async req => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const r = await tx.query('UPDATE clients SET active=false,updated_at=now() WHERE id=$1 RETURNING id', [id]);
      if (!r.rows.length) throw fail(404, 'not_found', 'Usuario no encontrado');
      await tx.query('DELETE FROM access_tokens WHERE client_id=$1', [id]);
      await audit(tx, req.admin.username, 'client.disabled', id);
    });
    return { ok: true, message: 'Baja lógica aplicada. Se conserva el historial.' };
  });
  app.post('/admin/clients/:id/rotate-secret', { preHandler: admin }, async req => {
    const id = uuid.parse(req.params.id), secret = randomToken(), encoded = await hashPassword(secret);
    const row = await db.transaction(async tx => {
      const r = await tx.query('UPDATE clients SET secret_hash=$2,updated_at=now() WHERE id=$1 RETURNING *', [id, encoded]);
      if (!r.rows.length) throw fail(404, 'not_found', 'Usuario no encontrado');
      await tx.query('DELETE FROM access_tokens WHERE client_id=$1', [id]);
      await audit(tx, req.admin.username, 'client.secret_rotated', id); return r.rows[0];
    });
    return { client_id: row.client_id, client_secret: secret, environment: config.environment };
  });
  app.post('/oauth/token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ grant_type: z.literal('client_credentials'), client_id: z.string().max(150).optional(),
      client_secret: z.string().max(512).optional(), scope: z.string().max(1000).optional() }).parse(req.body);
    let clientId = body.client_id, secret = body.client_secret;
    if (req.headers.authorization) {
      if (clientId || secret) throw fail(400, 'invalid_request', 'Usá Basic o credenciales en el body, no ambos');
      const encoded = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization)?.[1];
      if (!encoded) throw fail(401, 'invalid_client', 'Autenticación de cliente inválida');
      const decoded = Buffer.from(encoded, 'base64').toString('utf8'), idx = decoded.indexOf(':');
      if (idx < 0) throw fail(401, 'invalid_client', 'Credenciales inválidas');
      try { clientId = decodeURIComponent(decoded.slice(0, idx)); secret = decodeURIComponent(decoded.slice(idx + 1)); }
      catch { throw fail(401, 'invalid_client', 'Credenciales inválidas'); }
    }
    if (!clientId || !secret || secret.length > 512) throw fail(401, 'invalid_client', 'Credenciales inválidas');
    // Shared lock keeps token issuance consistent with concurrent secret rotation / deactivation.
    return db.transaction(async tx => {
      const record = (await tx.query('SELECT * FROM clients WHERE client_id=$1 FOR SHARE', [clientId])).rows[0];
      const valid = await verifyPassword(secret, record?.secret_hash || dummyHash);
      if (!valid || !record?.active) throw fail(401, 'invalid_client', 'Credenciales inválidas o usuario inactivo');
      const scopes = body.scope?.trim() ? [...new Set(body.scope.trim().split(/\s+/))] : record.scopes;
      if (scopes.some(s => !record.scopes.includes(s))) throw fail(400, 'invalid_scope', 'Scope no habilitado para este usuario');
      const token = randomToken();
      await tx.query('DELETE FROM access_tokens WHERE expires_at<now()');
      await tx.query('INSERT INTO access_tokens (token_hash,client_id,environment,scopes,expires_at) VALUES ($1,$2,$3,$4::jsonb,$5)',
        [digest(token), record.id, config.environment, j(scopes), new Date(Date.now() + config.tokenTtlSeconds * 1000)]);
      reply.header('Pragma', 'no-cache');
      return { token_type: 'Bearer', expires_in: config.tokenTtlSeconds, access_token: token, scope: scopes.join(' ') };
    });
  });
  for (const [kind, method, path] of [
    ['insert','POST','InsertMembershipBatch'], ['update','POST','UpdateMembershipBatch'],
    ['upgrade','POST','UpgradeMembershipBatch'], ['cancel','DELETE','CancelMembership'],
  ]) {
    app.route({ method, url: `/api/${path}`, preHandler: integration(`memberships:${kind}`), handler: async (req, reply) => {
      if (kind === 'upgrade' && !req.client.token_scopes.includes('memberships:update')) throw fail(403, 'insufficient_scope', 'UpgradeMembershipBatch también requiere memberships:update');
      if (Array.isArray(req.body) && req.body.some(item => item?.upgrades?.length) && !req.client.token_scopes.includes('memberships:upgrade')) {
        throw fail(403, 'insufficient_scope', 'El token también debe incluir memberships:upgrade para enviar upgrades');
      }
      const entries = Array.isArray(req.body) ? req.body : [req.body];
      if (entries.some(item => item?.override === true) && !req.client.token_scopes.includes('memberships:override')) throw fail(403, 'insufficient_scope', 'El token requiere memberships:override');
      const result = await enqueue(db, config, req.client, kind, req.body, req.headers['idempotency-key']);
      reply.code(kind === 'cancel' ? 202 : 200).header('Location', `/api/GetProcessStatus/${result.id}`);
      reply.header('Idempotency-Replayed', String(result.replay));
      return { ProcessID: result.id };
    } });
  }
  app.get('/api/GetProcessStatus/:id', { preHandler: integration('memberships:read') }, async req => {
    const { op, items } = await getOperation(db, req.params.id, req.client.id); return publicStatus(op, items);
  });
  app.get('/api/GetUpgrades', { preHandler: integration('memberships:read') }, async req => {
    let catalog;
    try { catalog = await gateway.upgrades(); } catch { throw fail(502, 'audax_unavailable', 'No se pudo consultar el catálogo de upgrades'); }
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw fail(502, 'audax_invalid_response', 'Catálogo no reconocido');
    return Object.fromEntries(Object.entries(catalog).filter(([business]) => req.client.business_ids.includes(business)));
  });
  app.get('/api/memberships', { preHandler: integration('memberships:read') }, async req => {
    const page = z.coerce.number().int().min(0).max(1000000).parse(req.query.offset || 0);
    return (await db.query('SELECT payload AS last_confirmed_request,status,updated_at FROM memberships WHERE client_id=$1 AND audax_mode=$3 ORDER BY updated_at DESC LIMIT 100 OFFSET $2', [req.client.id, page,config.mode])).rows;
  });
  app.get('/admin/overview', { preHandler: admin }, async () => {
    const statuses = (await db.query('SELECT status,count(*)::int AS count FROM operations WHERE audax_mode=$1 GROUP BY status',[config.mode])).rows;
    const clients = (await db.query('SELECT count(*)::int AS total,count(*) FILTER (WHERE active)::int AS active FROM clients')).rows[0];
    const health = (await db.query('SELECT last_seen FROM worker_health WHERE id=1')).rows[0];
    return { environment: config.environment, mode: config.mode, statuses, clients, worker_last_seen: health?.last_seen || null, audax_url: config.audaxBaseUrl, connection:settings?await settings.status():null };
  });
  app.get('/admin/operations', { preHandler: admin }, async req => {
    const offset = z.coerce.number().int().min(0).max(1000000).parse(req.query.offset || 0);
    return (await db.query(`SELECT o.id,o.kind,o.status,o.audax_process_id,o.attempts,o.created_at,o.updated_at,o.audax_mode,o.source,o.created_by,
      c.name,c.company_name,jsonb_array_length(o.membership_keys) AS item_count,
      EXISTS (SELECT 1 FROM operations e WHERE e.seq<o.seq AND e.audax_mode=o.audax_mode AND e.status='unknown'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.membership_keys) k WHERE o.membership_keys ? k.value)) AS blocked
      FROM operations o JOIN clients c ON c.id=o.client_id WHERE o.audax_mode=$2 ORDER BY o.seq DESC LIMIT 50 OFFSET $1`, [offset,config.mode])).rows;
  });
  app.get('/admin/operations/:id', { preHandler: admin }, async req => {
    const { op, items } = await getOperation(db, req.params.id);
    const attempts = (await db.query('SELECT phase,http_status,result,created_at FROM delivery_attempts WHERE operation_id=$1 ORDER BY id DESC LIMIT 30', [op.id])).rows;
    return { ...publicStatus(op, items), attempts };
  });
  app.post('/admin/operations/:id/reconcile', { preHandler: admin }, async req => {
    const { op } = await getOperation(db, req.params.id);
    if(op.audax_mode!==config.mode)throw fail(409,'mode_mismatch','El proceso pertenece a otro modo de conexión');
    const body = z.strictObject({ audax_process_id: z.uuid() }).parse(req.body);
    if (op.status !== 'unknown' || op.kind === 'cancel') throw fail(409, 'invalid_state', 'Solo se pueden conciliar lotes con resultado incierto');
    if (op.audax_process_id && op.audax_process_id !== body.audax_process_id) throw fail(409, 'process_mismatch', 'El lote ya tiene otro ProcessID de Audax');
    try { await gateway.poll(body.audax_process_id); } catch { throw fail(400, 'process_not_verified', 'No se pudo verificar el ProcessID en Audax'); }
    await db.transaction(async tx => {
      const r = await tx.query(`UPDATE operations SET status='submitted',audax_process_id=$2,error=NULL,lease_id=NULL,lease_until=NULL,
        tracking_started_at=now(),next_attempt_at=now(),updated_at=now() WHERE id=$1 AND status='unknown' RETURNING id`, [op.id, body.audax_process_id]);
      if (!r.rows.length) throw fail(409, 'invalid_state', 'El estado cambió; recargá el proceso');
      await tx.query("UPDATE operation_items SET status='pending',error=NULL WHERE operation_id=$1", [op.id]);
      await audit(tx, req.admin.username, 'operation.process_linked', op.id, { audax_process_id: body.audax_process_id });
    });
    return { ok: true, message: 'Se reanuda la consulta del proceso. No se reenvía la operación.' };
  });
  // Download allowlist: only generated public documentation, never configuration or secrets.
  app.get('/admin/downloads/:file',{preHandler:admin},async(req,reply)=>{
    const file=z.enum(['postman_collection.json','postman_test.environment.json','postman_prod.environment.json','openapi.json']).parse(req.params.file);
    const document=JSON.parse(await readFile(new URL(`../docs/${file}`,import.meta.url),'utf8'));
    if(file.includes('.environment.')){
      const environment=file.includes('_prod.')?'prod':'test';
      document.values.find(v=>v.key==='base_url').value=environment===config.environment?config.publicOrigin:config[environment+'PortalUrl'];
    }
    if(file==='postman_collection.json')document.variable.find(v=>v.key==='base_url').value=config.publicOrigin;
    return reply.header('Content-Disposition',`attachment; filename="${file}"`).type('application/json').send(document);
  });
  app.get('/admin/audit', { preHandler: admin }, async () => (await db.query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 100')).rows);
  // Serve an exact allowlist. No filesystem path is ever derived from the request URL.
  for (const [path, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/brand.css','brand.css','text/css; charset=utf-8'],
    ['/assets/wmc-logo.png','assets/wmc-logo.png','image/png'],
    ['/assets/wmms-logo.png','assets/wmms-logo.png','image/png'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/audax-modules.js','audax-modules.js','text/javascript; charset=utf-8'],
    ['/audax-modules.css','audax-modules.css','text/css; charset=utf-8'],
  ]) {
    const content = await readFile(new URL(`../public/${file}`, import.meta.url));
    app.get(path, async (_req, reply) => reply.type(type).send(content));
  }
  return app;
}
