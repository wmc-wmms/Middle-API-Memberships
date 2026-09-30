/**
 * Rutas administrativas de TEST y PROD: conexión, catálogos, carga y resultados. Exigen sesión/CSRF; LOCAL_PREVIEW bloquea credenciales PROD.
 */
import { z } from 'zod';
import { fail } from './security.mjs';
import { enqueue } from './operations.mjs';

export function registerAdminRoutes(app,{db,config,settings,catalogs,admin}) {
  async function guarded(req) {
    await admin(req);
    if(config.mode!=='live'||!settings||!catalogs)throw fail(409,'test_live_required','Este módulo requiere Audax real');
  }
  app.get('/admin/audax/settings',{preHandler:guarded},()=>settings.status());
  app.put('/admin/audax/settings',{preHandler:guarded},req=>settings.save(req.body,req.admin.username));
  app.post('/admin/audax/test',{preHandler:guarded},async req=>{
    if(!(await settings.status()).configured)throw fail(400,'connection_not_configured','Primero guardá client ID, secret y scope de Audax');
    return settings.test(req.admin.username);
  });
  app.get('/admin/catalogs',{preHandler:guarded},()=>catalogs.snapshot());
  app.post('/admin/catalogs/sync',{preHandler:guarded},async(req,reply)=>reply.code(202).send(await catalogs.requestSync(req.admin.username)));
  // Read-only diagnostic: only update local state through the worker, using an already stored Audax ID.
  app.get('/admin/audax/process/:id',{preHandler:guarded},async req=>{
    const id=z.uuid().parse(req.params.id);
    const {adapter}=await settings.adapter();
    const result=await adapter.poll(id);
    const local=(await db.query('SELECT id,status FROM operations WHERE audax_process_id=$1 AND audax_mode=$2',[id,config.mode])).rows;
    // Wake up known pending processes; never attach an arbitrary remote ID to a different local batch.
    await db.query("UPDATE operations SET next_attempt_at=now() WHERE audax_process_id=$1 AND audax_mode=$2 AND status='submitted'",[id,config.mode]);
    return {environment:config.environment,audax_process_id:id,status:result.state,result:result.body,local_operations:local};
  });
  app.get('/admin/membership-activity',{preHandler:guarded},async req=>{
    const search=z.string().max(200).parse(req.query.search||'');
    return (await db.query(`SELECT o.id,o.kind,o.status,o.audax_process_id,o.created_at,o.updated_at,
      i.payload->>'membership_number' AS membership_number,i.item_index,i.error,c.company_name
      FROM operations o JOIN operation_items i ON i.operation_id=o.id JOIN clients c ON c.id=o.client_id
      WHERE o.audax_mode=$1 AND (i.payload->>'membership_number' ILIKE $2 OR c.company_name ILIKE $2)
      ORDER BY o.seq DESC,i.item_index LIMIT 50`,[config.mode,`%${search}%`])).rows;
  });
  app.get('/admin/memberships',{preHandler:guarded},async req=>{
    const query=z.object({search:z.string().max(200).default(''),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).parse(req.query);
    const rows=(await db.query(`SELECT m.*,c.name AS client_name,c.company_name,o.source FROM memberships m
      JOIN clients c ON c.id=m.client_id JOIN operations o ON o.id=m.last_operation_id
      WHERE m.audax_mode='live' AND (m.payload->>'membership_number' ILIKE $1 OR m.payload->>'last_name' ILIKE $1
        OR m.payload->>'first_name' ILIKE $1 OR c.company_name ILIKE $1)
      ORDER BY m.updated_at DESC LIMIT 50 OFFSET $2`,[`%${query.search}%`,query.offset])).rows;
    return rows;
  });
  app.post('/admin/memberships/manual',{preHandler:guarded},async(req,reply)=>{
    const body=z.strictObject({client_id:z.uuid(),kind:z.enum(['insert','update','upgrade','cancel']),membership:z.record(z.string(),z.unknown())}).parse(req.body);
    const client=(await db.query('SELECT * FROM clients WHERE id=$1',[body.client_id])).rows[0];
    if(!client)throw fail(404,'client_not_found','Usuario API no encontrado');
    const result=await enqueue(db,config,client,body.kind,body.kind==='cancel'?body.membership:[body.membership],req.headers['idempotency-key'],{source:'manual',actor:req.admin.username});
    return reply.code(202).send({ProcessID:result.id,status:'processing',environment:config.environment,replay:result.replay});
  });
}
