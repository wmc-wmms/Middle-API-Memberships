/**
 * Envía una vez y consulta GetProcessStatus hasta un estado final. Prioriza consultas pendientes; una escritura incierta nunca se reenvía automáticamente.
 */
import { randomUUID } from 'node:crypto';
import { AudaxError } from './audax.mjs';
import { audit } from './security.mjs';
import { validatePayload } from './validation.mjs';
const j = JSON.stringify;
export class Worker {
  constructor(db, gateway, config, catalogs = null) { Object.assign(this, { db, gateway, config, catalogs }); this.running = false; this.stopped = false; }
  async recover() {
    await this.db.transaction(async tx => {
      const lost = await tx.query(`UPDATE operations SET status='unknown',error=$1::jsonb,lease_id=NULL,lease_until=NULL,updated_at=now()
        WHERE status='sending' AND lease_until < now() AND audax_mode=$2 RETURNING id`, [j({ message: 'Worker interrumpido durante el envío: requiere conciliación; no se reenvía' }),this.config.mode]);
      for (const row of lost.rows) await tx.query("UPDATE operation_items SET status='unknown' WHERE operation_id=$1", [row.id]);
      await tx.query("UPDATE operations SET lease_id=NULL,lease_until=NULL WHERE status='submitted' AND lease_until < now() AND audax_mode=$1",[this.config.mode]);
    });
  }
  async claim() {
    return this.db.transaction(async tx => {
      const result = await tx.query(`SELECT o.* FROM operations o
        WHERE o.status IN ('queued','submitted') AND o.next_attempt_at <= now() AND o.lease_id IS NULL AND o.audax_mode=$1
        AND (o.status='submitted' OR NOT EXISTS (
          SELECT 1 FROM operations earlier
          WHERE earlier.seq < o.seq AND earlier.audax_mode=o.audax_mode AND earlier.status IN ('queued','sending','submitted','unknown')
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(earlier.membership_keys) k
            WHERE o.membership_keys ? k.value)
        )) ORDER BY (o.status='submitted') DESC,o.seq FOR UPDATE OF o SKIP LOCKED LIMIT 1`,[this.config.mode]);
      const op = result.rows[0];
      if (!op) return null;
      op.phase = op.status === 'submitted' ? 'poll' : 'submit'; op.lease_id = randomUUID();
      // 5 minutes exceeds the bounded token/request/refresh sequence; never hold a DB transaction during HTTP.
      await tx.query(`UPDATE operations SET status=$2,lease_id=$3,lease_until=now()+interval '5 minutes',
        attempts=attempts+$4,poll_attempts=poll_attempts+$5,updated_at=now() WHERE id=$1`,
      [op.id, op.phase === 'submit' ? 'sending' : 'submitted', op.lease_id, op.phase === 'submit' ? 1 : 0, op.phase === 'poll' ? 1 : 0]);
      op.attempts += op.phase === 'submit' ? 1 : 0;
      return op;
    });
  }
  async finish(op, state, { result = null, error = null, processId = null, delay = 0, httpStatus = null } = {}) {
    await this.db.transaction(async tx => {
      const updated = await tx.query(`UPDATE operations SET status=$3,response=COALESCE($4::jsonb,response),error=$5::jsonb,
        audax_process_id=COALESCE($6,audax_process_id),tracking_started_at=CASE WHEN $6::text IS NOT NULL THEN now() ELSE tracking_started_at END,
        next_attempt_at=$7,lease_id=NULL,lease_until=NULL,updated_at=now()
        WHERE id=$1 AND lease_id=$2 RETURNING id`,
      [op.id, op.lease_id, state, result === null ? null : j(result), error === null ? null : j(error), processId, new Date(Date.now() + delay)]);
      if (!updated.rows.length) return; // An expired worker must not overwrite a newer lease/reconciliation.
      await tx.query('INSERT INTO delivery_attempts (operation_id,phase,http_status,result) VALUES ($1,$2,$3,$4::jsonb)',
        [op.id, op.phase, httpStatus, j(error ?? result ?? {})]);
      if (['finished','failed','unknown'].includes(state)) {
        const items = (await tx.query('SELECT * FROM operation_items WHERE operation_id=$1 ORDER BY item_index', [op.id])).rows;
        const errors = error?.errors?.Errors || error?.Errors || error?.errors || {};
        for (const item of items) {
          const itemError = state === 'finished' ? null : errors[String(item.item_index)] || error || { message: 'El lote completo falló; Audax no aplica cambios parciales' };
          await tx.query('UPDATE operation_items SET status=$3,error=$4::jsonb WHERE operation_id=$1 AND item_index=$2',
            [op.id, item.item_index, state, itemError === null ? null : j(itemError)]);
          if (state === 'finished') {
            if (op.kind === 'cancel') {
              await tx.query(`INSERT INTO memberships (client_id,membership_key,payload,status,last_operation_id,audax_mode)
                VALUES ($1,$2,$3::jsonb,'cancelled',$4,$5) ON CONFLICT(client_id,membership_key,audax_mode)
                DO UPDATE SET status='cancelled',last_operation_id=EXCLUDED.last_operation_id,updated_at=now()`,
              [op.client_id, item.membership_key, j(item.payload), op.id,op.audax_mode]);
            } else {
              await tx.query(`INSERT INTO memberships (client_id,membership_key,payload,status,last_operation_id,audax_mode)
                VALUES ($1,$2,$3::jsonb,'active',$4,$5) ON CONFLICT(client_id,membership_key,audax_mode)
                DO UPDATE SET payload=EXCLUDED.payload,status='active',last_operation_id=EXCLUDED.last_operation_id,updated_at=now()`,
              [op.client_id, item.membership_key, j(item.payload), op.id,op.audax_mode]);
            }
          }
        }
        await audit(tx, 'worker', `membership.${state}`, op.id);
      }
    });
  }
  async tick() {
    if (this.running) return false;
    this.running = true;
    try {
      await this.db.query('INSERT INTO worker_health (id,last_seen) VALUES (1,now()) ON CONFLICT(id) DO UPDATE SET last_seen=now()');
      await this.recover();
      // Status checks take priority over catalog downloads and new submissions.
      const duePoll=(await this.db.query("SELECT 1 FROM operations WHERE audax_mode=$1 AND status='submitted' AND next_attempt_at<=now() AND lease_id IS NULL LIMIT 1",[this.config.mode])).rows.length;
      if(!duePoll&&this.catalogs&&await this.catalogs.tick())return true;
      if(this.gateway.isReady&&!await this.gateway.isReady())return false;
      const op = await this.claim();
      if (!op) return false;
      if (op.phase === 'poll' && Date.now() - new Date(op.tracking_started_at).valueOf() > this.config.maxPollAgeMs) {
        await this.finish(op, 'unknown', { error: { message: 'Se agotó la ventana de seguimiento. Conciliar usando el ProcessID de Audax.' } });
        return true;
      }
      try {
        if (op.phase === 'submit') {
          const client = (await this.db.query('SELECT * FROM clients WHERE id=$1', [op.client_id])).rows[0];
          if (!client?.active || !client.scopes.includes(`memberships:${op.kind}`)) throw new AudaxError('Usuario dado de baja o permiso revocado antes del envío');
          try {
            // Validate revocations, but never re-sync catalogs or repeat connection setup after reception.
            validatePayload(op.kind, op.payload, client, this.config.maxBatch, this.config.allowOverride);
          } catch(error) {
            if(error.statusCode || error.message==='Identidad Audax distinta')throw new AudaxError('Permisos, catálogos o conexión cambiaron antes del envío. No se envió a Audax.');
            throw error;
          }
          const r = await this.gateway.submit(op);
          await this.finish(op, r.finished ? 'finished' : 'submitted', {
            result: r.body, processId: r.processId, delay: this.config.pollMs, httpStatus: r.status,
          });
        } else {
          const r = await this.gateway.poll(op.audax_process_id);
          await this.finish(op, r.state === 'processing' ? 'submitted' : r.state, {
            result: r.body, error: r.state === 'failed' ? r.body.errors || r.body.Errors || { message: 'Audax rechazó todo el lote' } : null,
            delay: this.config.pollMs, httpStatus: r.status,
          });
        }
      } catch (error) {
        // Non-Audax exceptions may be local persistence failures after remote success: leave the lease for recovery.
        if (!(error instanceof AudaxError)) throw error;
        const state = op.phase === 'poll' ? (error.retryable ? 'submitted' : 'unknown')
          : error.uncertain ? 'unknown' : error.retryable && op.attempts < this.config.maxAttempts ? 'queued' : 'failed';
        const delay = Math.max(error.retryAfter || 0, Math.min(300000, 1000 * 2 ** Math.min(op.attempts, 8)) + Math.floor(Math.random() * 500));
        await this.finish(op, state, { error: error.body || { message: error.message }, httpStatus: error.status, delay });
      }
      return true;
    } finally { this.running = false; }
  }
  start(onError = () => {}) {
    const loop = async () => {
      if (this.stopped) return;
      try { await this.tick(); } catch (error) { onError(error); }
      if (!this.stopped) this.timer = setTimeout(loop, 1000);
    };
    void loop();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); while (this.running) await new Promise(r => setTimeout(r, 50)); }
}
