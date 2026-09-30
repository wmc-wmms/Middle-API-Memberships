/**
 * Adaptador HTTP externo: token Microsoft, límites, timeout y errores. GET puede repetirse; una escritura incierta exige conciliación.
 */
import { randomUUID } from 'node:crypto';
export class AudaxError extends Error {
  constructor(message, { status = null, body = null, retryable = false, uncertain = false, retryAfter = 0 } = {}) {
    super(message); Object.assign(this, { status, body, retryable, uncertain, retryAfter });
  }
}
async function boundedBody(response, limit = 2 * 1024 * 1024) {
  if (!response.body) return null;
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Respuesta demasiado grande');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 4000) }; }
}
function retryDelay(header) {
  if (!header) return 0;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Math.min(86400000, Math.max(0, ms || 0));
}
export class LiveAudax {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; this.token = null; this.expires = 0; }
  async accessToken() {
    if (this.token && this.expires > Date.now() + 60000) return this.token;
    if (this.tokenFlight) return this.tokenFlight;
    this.tokenFlight = this.fetchToken();
    try { return await this.tokenFlight; } finally { this.tokenFlight = null; }
  }
  async fetchToken() {
    let response, body;
    try {
      response = await this.fetcher(this.config.audaxTokenUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.audaxClientId,
          client_secret: this.config.audaxClientSecret, scope: this.config.audaxScope }),
      });
      body = await boundedBody(response);
    } catch { throw new AudaxError('No se pudo obtener el token de Audax; no se envió la operación', { retryable: true }); }
    if (!response.ok || !body?.access_token) throw new AudaxError('Audax rechazó la autenticación; no se envió la operación', { status: response.status, retryable: response.status >= 500 || response.status === 429 });
    this.token = body.access_token;
    this.expires = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return this.token;
  }
  async request(method, path, payload, refresh = true, responseLimit = 2 * 1024 * 1024) {
    const token = await this.accessToken();
    let response, body;
    try {
      response = await this.fetcher(`${this.config.audaxBaseUrl}/${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      body = await boundedBody(response, responseLimit);
    } catch {
      throw new AudaxError('No se pudo confirmar la respuesta de Audax', { retryable: method === 'GET', uncertain: method !== 'GET' });
    }
    if (response.status === 401 && refresh) { this.token = null; return this.request(method, path, payload, false, responseLimit); }
    if (!response.ok) throw new AudaxError(`Audax respondió HTTP ${response.status}`, {
      status: response.status, body,
      retryable: response.status === 429 || method === 'GET' && response.status >= 500,
      uncertain: method !== 'GET' && (response.status >= 500 || response.status === 408),
      retryAfter: retryDelay(response.headers.get('retry-after')),
    });
    return { status: response.status, body };
  }
  async submit(op) {
    const endpoint = { insert: 'InsertMembershipBatch', update: 'UpdateMembershipBatch', upgrade: 'UpdateMembershipBatch', cancel: 'CancelMembership' }[op.kind];
    const result = await this.request(op.kind === 'cancel' ? 'DELETE' : 'POST', endpoint, op.payload);
    if (op.kind === 'cancel') {
      if (result.status !== 200 || result.body?.errors || result.body?.Errors) throw new AudaxError('Respuesta de baja no reconocida', { uncertain: true, ...result });
      return { ...result, finished: true };
    }
    const processId = result.body?.ProcessID;
    if (result.status !== 200 || typeof processId !== 'string' || !processId.trim()) throw new AudaxError('Audax no devolvió el ProcessID documentado', { uncertain: true, ...result });
    return { ...result, processId };
  }
  async poll(id) {
    const result = await this.request('GET', `GetProcessStatus/${encodeURIComponent(id)}`);
    if (!['processing', 'finished', 'failed'].includes(result.body?.status) || result.body?.id !== id) {
      throw new AudaxError('Estado de proceso Audax no reconocido o identificador distinto', { retryable: true, status: result.status });
    }
    return { ...result, state: result.body.status };
  }
  async upgrades() { return (await this.request('GET', 'GetUpgrades')).body; }
  async catalog(endpoint) {
    if (!['GetBusiness','GetPlans','GetCountries','GetCurrencies','GetLocationGroups','GetConditions','GetUpgrades'].includes(endpoint)) throw new Error('Catálogo no permitido');
    return this.request('GET',endpoint,undefined,true,16*1024*1024);
  }
}
export class MockAudax {
  constructor(db) { this.db = db; }
  async submit(op) {
    if (op.kind === 'cancel') return { status: 200, body: { message: 'Baja simulada' }, finished: true };
    const processId = randomUUID();
    const shouldFail = op.payload.some(item => item.membership_number.startsWith('MOCK-FAIL'));
    await this.db.query('INSERT INTO mock_processes (id,fail) VALUES ($1,$2)', [processId, shouldFail]);
    return { status: 200, body: { ProcessID: processId }, processId };
  }
  async poll(id) {
    const record = (await this.db.query('SELECT * FROM mock_processes WHERE id=$1', [id])).rows[0];
    if (!record) throw new AudaxError('Proceso simulado no encontrado', { status: 404 });
    return { status: 200, state: record.fail ? 'failed' : 'finished', body: {
      id, status: record.fail ? 'failed' : 'finished',
      ...(record.fail ? { errors: { Errors: { '0': { Errors: ['Rechazo simulado para MOCK-FAIL'] } } } } : {}),
    } };
  }
  async upgrades() { return { DEMO: [{ upgrade_id: '22', condition_id: '90', rules: [] }] }; }
}
