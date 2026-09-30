/**
 * Recepción transaccional: permisos, validación, idempotencia y persistencia antes de responder. ProcessID público es local; el ID remoto se guarda después.
 */
import { randomUUID } from 'node:crypto';
import { canonical, digest, fail, audit } from './security.mjs';
import { validatePayload } from './validation.mjs';
import { validateMembershipCatalog } from './catalogs.mjs';
export async function enqueue(db, config, client, kind, body, idempotencyKey, metadata = {}) {
  if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(idempotencyKey)) {
    throw fail(400, 'idempotency_key_required', 'Enviá Idempotency-Key: entre 8 y 128 caracteres ASCII sin espacios');
  }
  return db.transaction(async tx => {
    const fresh = (await tx.query('SELECT * FROM clients WHERE id=$1 FOR SHARE', [client.id])).rows[0];
    if (!fresh?.active || !fresh.scopes.includes(`memberships:${kind}`)) throw fail(403, 'client_disabled', 'Usuario inactivo o permiso revocado');
    const validated = validatePayload(kind, body, fresh, config.maxBatch, config.allowOverride);
    const hash = digest(canonical({ kind, payload: validated.payload }));
    // A committed request remains replayable even if the catalog changes afterwards.
    const previous=(await tx.query('SELECT id,payload_hash,audax_mode FROM operations WHERE client_id=$1 AND idempotency_key=$2',[client.id,idempotencyKey])).rows[0];
    if(previous){
      if(previous.payload_hash!==hash||previous.audax_mode!==config.mode)throw fail(409,'idempotency_conflict','Esta clave ya fue usada para otro contenido, operación o modo');
      return {id:previous.id,replay:true};
    }
    const fingerprint=await validateMembershipCatalog(tx,config,fresh,validated.items);
    const id = randomUUID();
    const inserted = await tx.query(`INSERT INTO operations
      (id,client_id,kind,idempotency_key,payload_hash,payload,membership_keys,audax_mode,connection_fingerprint,source,created_by)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
      ON CONFLICT(client_id,idempotency_key) DO NOTHING RETURNING id`,
    [id, client.id, kind, idempotencyKey, hash, JSON.stringify(validated.payload), JSON.stringify(validated.keys),config.mode,fingerprint,metadata.source||'api',metadata.actor||null]);
    if (!inserted.rows.length) {
      const existing = (await tx.query('SELECT id,payload_hash,audax_mode FROM operations WHERE client_id=$1 AND idempotency_key=$2', [client.id, idempotencyKey])).rows[0];
      if (existing.payload_hash !== hash || existing.audax_mode !== config.mode) throw fail(409, 'idempotency_conflict', 'Esta clave ya fue usada para otro contenido u operación');
      return { id: existing.id, replay: true };
    }
    for (const [i, item] of validated.items.entries()) {
      await tx.query('INSERT INTO operation_items (operation_id,item_index,membership_key,payload) VALUES ($1,$2,$3,$4::jsonb)',
        [id, i, validated.keys[i], JSON.stringify(item)]);
    }
    await audit(tx, metadata.actor||client.client_id, `membership.${kind}.queued`, id, { count: validated.items.length, source:metadata.source||'api',client_id:client.id });
    return { id, replay: false };
  });
}
export function publicStatus(op, items = []) {
  return {
    id: op.id,
    status: op.status === 'finished' ? 'finished' : op.status === 'failed' ? 'failed' : op.status === 'unknown' ? 'unknown' : 'processing',
    middleware_status: op.status, operation: op.kind, audax_process_id: op.audax_process_id,
    audax_mode:op.audax_mode,source:op.source,created_by:op.created_by,
    ...(op.error ? { errors: op.error } : {}),
    created_at: op.created_at, updated_at: op.updated_at,
    items: items.map(i => ({ index: i.item_index, membership_number: i.payload.membership_number, status: i.status, ...(i.error ? { errors: i.error } : {}) })),
  };
}
export async function getOperation(db, id, clientId) {
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw fail(404, 'not_found', 'Proceso no encontrado');
  const op = (await db.query(`SELECT * FROM operations WHERE id=$1${clientId ? ' AND client_id=$2' : ''}`, clientId ? [id, clientId] : [id])).rows[0];
  if (!op) throw fail(404, 'not_found', 'Proceso no encontrado');
  const items = (await db.query('SELECT * FROM operation_items WHERE operation_id=$1 ORDER BY item_index', [id])).rows;
  return { op, items };
}
