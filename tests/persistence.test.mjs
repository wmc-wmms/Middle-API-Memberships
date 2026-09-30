import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configFromEnv } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { Worker } from '../src/worker.mjs';
test('base persistente conserva datos y rechaza cruzar simulador/real o TEST/PROD',async()=>{
  const root=await mkdtemp(join(tmpdir(),'audax-gateway-test-'));
  const config=configFromEnv({AUDAX_MODE:'mock',LOCAL_DATA_DIR:join(root,'database')});
  let db;
  try {
    db=await openDatabase(config);
    const id=randomUUID();
    await db.query('INSERT INTO admins (id,username,password_hash) VALUES ($1,$2,$3)',[id,'persisted','test-hash']);
    await db.close();db=null;
    db=await openDatabase(config);assert.equal((await db.query('SELECT id FROM admins')).rows[0].id,id);
    await db.close();db=null;
    await assert.rejects(openDatabase({...config,mode:'live'}),/otro ambiente o modo/);
    db=await openDatabase(config);
    await db.query("UPDATE environment_lock SET environment='prod' WHERE id=1");
    await db.close();db=null;
    await assert.rejects(openDatabase(config),/otro ambiente o modo/);
  }finally{
    if(db)await db.close();
    const absolute=resolve(root),allowed=resolve(tmpdir())+sep;
    if(!absolute.startsWith(allowed)||!absolute.split(sep).at(-1).startsWith('audax-gateway-test-'))throw new Error('Ruta temporal fuera del directorio permitido');
    await rm(absolute,{recursive:true,force:true});
  }
});

test('migración de esquema antiguo conserva usuarios y operaciones mock sin enviarlas a TEST real',async()=>{
  const root=await mkdtemp(join(tmpdir(),'audax-gateway-test-'));
  const config=configFromEnv({AUDAX_MODE:'live',ALLOW_TEST_LIVE_MIGRATION:'true',LOCAL_DATA_DIR:join(root,'database')});
  let db,legacy;
  try{
    const {PGlite}=await import('@electric-sql/pglite');legacy=new PGlite(config.localData);await legacy.waitReady;
    await legacy.exec(await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8'));
    await legacy.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz DEFAULT now()); INSERT INTO schema_migrations(version) VALUES(1)');
    await legacy.exec("INSERT INTO environment_lock VALUES(1,'test','mock')");
    const admin=randomUUID(),client=randomUUID(),operation=randomUUID();
    await legacy.query('INSERT INTO admins(id,username,password_hash) VALUES($1,$2,$3)',[admin,'preserved','hash']);
    await legacy.query("INSERT INTO clients(id,name,company_name,client_id,secret_hash,business_ids,plan_ids,scopes) VALUES($1,'user','company','integration-client','hash','[\"30\"]','[\"1139\"]','[\"memberships:insert\"]')",[client]);
    await legacy.query("INSERT INTO operations(id,client_id,kind,idempotency_key,payload_hash,payload,membership_keys) VALUES($1,$2,'insert','old-key-001','hash','[]','[]')",[operation,client]);
    await legacy.query("INSERT INTO access_tokens VALUES('old-token',$1,'test','[]',now()+interval '1 hour')",[client]);
    await legacy.close();legacy=null;
    db=await openDatabase(config);
    assert.equal((await db.query('SELECT id FROM admins')).rows[0].id,admin);
    assert.equal((await db.query('SELECT id FROM clients')).rows[0].id,client);
    assert.equal((await db.query('SELECT * FROM access_tokens')).rows.length,0);
    assert.equal((await db.query('SELECT audax_mode FROM operations')).rows[0].audax_mode,'mock');
    let sends=0;const worker=new Worker(db,{submit:async()=>{sends++;throw new Error('Must not send')}},config);
    assert.equal(await worker.tick(),false);assert.equal(sends,0);
    assert.equal((await db.query('SELECT status FROM operations')).rows[0].status,'queued');
    await db.close();db=null;
    db=await openDatabase({...config,allowTestLiveMigration:false});assert.equal((await db.query('SELECT audax_mode FROM environment_lock')).rows[0].audax_mode,'live');
  }finally{
    if(legacy)await legacy.close();if(db)await db.close();
    const absolute=resolve(root),allowed=resolve(tmpdir())+sep;
    if(!absolute.startsWith(allowed)||!absolute.split(sep).at(-1).startsWith('audax-gateway-test-'))throw new Error('Ruta temporal fuera del directorio permitido');
    await rm(absolute,{recursive:true,force:true});
  }
});
