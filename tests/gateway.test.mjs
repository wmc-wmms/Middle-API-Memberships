import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv, AUDAX_URLS } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { buildApp } from '../src/app.mjs';
import { Worker } from '../src/worker.mjs';
import { MockAudax, LiveAudax, AudaxError } from '../src/audax.mjs';
import { ALL_SCOPES, validatePayload } from '../src/validation.mjs';
let db, app, gateway, adminHeaders, ip = 1;
const config = { ...configFromEnv({ AUDAX_MODE:'mock', ADMIN_USERNAME:'admin', ADMIN_PASSWORD:'test-admin-password-12345', LOCAL_DATA_DIR:':memory:' }), pollMs:0 };
const sample = overrides => ({ plan_id:'999',membership_number:'MEM001',national_id:'AB123456',business_id:'111',last_name:'Doe',first_name:'John',issued_country:'14',date_of_birth:'1980-05-15',issued_date:'2027-01-01',valid_from:'2027-02-01',valid_to:'2027-03-01',max_consecutive_days_per_trip:30,price:10,currency_id:'157',...overrides });
const clientBody = overrides => ({ name:'Integración A',company_name:'Empresa A',email:'',business_ids:['111'],plan_ids:['999'],scopes:ALL_SCOPES,active:true,...overrides });
const inject = options => app.inject({ remoteAddress:`10.0.${Math.floor(ip/250)}.${ip++%250+1}`, ...options });
async function createClient(overrides={}) {
  const r=await inject({method:'POST',url:'/admin/clients',headers:adminHeaders,payload:clientBody(overrides)});
  assert.equal(r.statusCode,201,r.body); return r.json();
}
async function token(client,scope) {
  const r=await inject({method:'POST',url:'/oauth/token',payload:{grant_type:'client_credentials',client_id:client.client_id,client_secret:client.client_secret,...(scope?{scope}:{})}});
  assert.equal(r.statusCode,200,r.body); return r.json().access_token;
}
async function send(access,kind,payload,key='request-0001') {
  const endpoint={insert:'InsertMembershipBatch',update:'UpdateMembershipBatch',upgrade:'UpgradeMembershipBatch',cancel:'CancelMembership'}[kind];
  return inject({method:kind==='cancel'?'DELETE':'POST',url:`/api/${endpoint}`,headers:{authorization:`Bearer ${access}`,'idempotency-key':key},payload});
}
async function process(worker = new Worker(db,gateway,config)) { await worker.tick(); await worker.tick(); }
before(async()=>{
  db=await openDatabase(config);gateway=new MockAudax(db);app=await buildApp({db,config,gateway});
  const r=await inject({method:'POST',url:'/admin/login',payload:{username:'admin',password:'test-admin-password-12345'}});
  assert.equal(r.statusCode,200,r.body);
  adminHeaders={cookie:r.headers['set-cookie'].split(';')[0],'x-csrf-token':r.json().csrf_token};
});
beforeEach(async()=>{await db.exec('TRUNCATE clients, operations, operation_items, memberships, access_tokens, delivery_attempts, mock_processes, audit_events RESTART IDENTITY CASCADE');});
after(async()=>{await app?.close();await db?.close();});

test('ABM genera secretos de una sola visualización; edición y baja revocan tokens',async()=>{
  const c=await createClient();assert.match(c.client_id,/^audax_test_/);assert.ok(c.client_secret.length>=40);
  const stored=(await db.query('SELECT secret_hash FROM clients WHERE id=$1',[c.id])).rows[0];assert.notEqual(stored.secret_hash,c.client_secret);
  const list=await inject({url:'/admin/clients',headers:adminHeaders});assert.equal(list.json()[0].client_secret,undefined);assert.equal(list.json()[0].secret_hash,undefined);
  let access=await token(c);
  const changed=await inject({method:'PUT',url:`/admin/clients/${c.id}`,headers:adminHeaders,payload:clientBody({company_name:'Empresa nueva'})});assert.equal(changed.json().company_name,'Empresa nueva');
  assert.equal((await send(access,'insert',[sample()])).statusCode,401);
  access=await token(c);
  const disabled=await inject({method:'DELETE',url:`/admin/clients/${c.id}`,headers:adminHeaders});assert.equal(disabled.statusCode,200);
  assert.equal((await send(access,'insert',[sample()])).statusCode,401);
  const credentials=await inject({method:'POST',url:'/oauth/token',payload:{grant_type:'client_credentials',client_id:c.client_id,client_secret:c.client_secret}});assert.equal(credentials.statusCode,401);
  assert.equal((await db.query('SELECT active FROM clients WHERE id=$1',[c.id])).rows[0].active,false);
});
test('rotación invalida secret y tokens anteriores',async()=>{
  const c=await createClient(),access=await token(c);
  const rotated=await inject({method:'POST',url:`/admin/clients/${c.id}/rotate-secret`,headers:adminHeaders});assert.equal(rotated.statusCode,200);
  assert.notEqual(rotated.json().client_secret,c.client_secret);
  assert.equal((await send(access,'insert',[sample()])).statusCode,401);
  const old=await inject({method:'POST',url:'/oauth/token',payload:{grant_type:'client_credentials',client_id:c.client_id,client_secret:c.client_secret}});assert.equal(old.statusCode,401);
  await token({...c,...rotated.json()});
});
test('el panel requiere sesión y CSRF; rechaza origen ajeno',async()=>{
  assert.equal((await inject({url:'/admin/clients'})).statusCode,401);
  assert.equal((await inject({method:'POST',url:'/admin/clients',headers:{cookie:adminHeaders.cookie},payload:clientBody()})).statusCode,403);
  assert.equal((await inject({method:'POST',url:'/admin/clients',headers:{...adminHeaders,origin:'https://ajeno.example'},payload:clientBody()})).statusCode,403);
});
test('OAuth permite form-urlencoded y Basic; restringe scopes',async()=>{
  const c=await createClient({scopes:['memberships:read']});
  const r=await inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded',authorization:`Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64')}`},payload:'grant_type=client_credentials&scope=memberships%3Aread'});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().scope,'memberships:read');
  assert.equal((await send(r.json().access_token,'insert',[sample()])).statusCode,403);
  const invalid=await inject({method:'POST',url:'/oauth/token',payload:{grant_type:'client_credentials',client_id:c.client_id,client_secret:c.client_secret,scope:'memberships:cancel'}});assert.equal(invalid.statusCode,400);
});
test('empresa/plan, fechas reales y atomicidad se validan antes de persistir',async()=>{
  const access=await token(await createClient());
  for(const overrides of [{business_id:'OTRA'},{plan_id:'OTRO'}])assert.equal((await send(access,'insert',[sample(overrides)])).statusCode,403);
  for(const overrides of [{date_of_birth:'1980-02-30'},{valid_to:'2027-01-01'},{price:-1},{national_id:undefined},{upgrades:[{'22':{valid_from:'2027-02-01',valid_to:'2028-01-01'}}]}])assert.equal((await send(access,'insert',[sample(),sample({...overrides,membership_number:'MEM002'})])).statusCode,400);
  assert.equal((await db.query('SELECT count(*)::int n FROM operations')).rows[0].n,0);
  assert.equal((await send(access,'insert',[sample(),sample()])).statusCode,400);
});
test('idempotencia cubre reintentos concurrentes, orden de claves y conflictos de contenido',async()=>{
  const access=await token(await createClient());
  const [a,b]=await Promise.all([send(access,'insert',[sample()]),send(access,'insert',[sample()])]);assert.equal(a.statusCode,200,a.body);assert.equal(b.statusCode,200,b.body);assert.equal(a.json().ProcessID,b.json().ProcessID);
  assert.equal((await db.query('SELECT count(*)::int n FROM operations')).rows[0].n,1);
  const reordered=Object.fromEntries(Object.entries(sample()).reverse());assert.equal((await send(access,'insert',[reordered])).json().ProcessID,a.json().ProcessID);
  assert.equal((await send(access,'insert',[sample({price:20})])).statusCode,409);
  assert.equal((await send(access,'update',[sample()])).statusCode,409);
});
test('alta, modificación, upgrade y baja completan el circuito y guardan la proyección confirmada',async()=>{
  const c=await createClient(),access=await token(c),worker=new Worker(db,gateway,config);
  const created=await send(access,'insert',[sample()]);assert.equal(created.statusCode,200);
  await worker.tick();
  let status=await inject({url:`/api/GetProcessStatus/${created.json().ProcessID}`,headers:{authorization:`Bearer ${access}`}});assert.equal(status.json().status,'processing');assert.ok(status.json().audax_process_id);
  assert.equal((await db.query('SELECT count(*)::int n FROM memberships')).rows[0].n,0);
  await worker.tick();
  status=await inject({url:`/api/GetProcessStatus/${created.json().ProcessID}`,headers:{authorization:`Bearer ${access}`}});assert.equal(status.json().status,'finished');assert.equal(status.json().items[0].status,'finished');
  await send(access,'update',[sample({first_name:'Jane'})],'request-update');await process(worker);
  const upgraded=sample({first_name:'Jane',upgrades:[{'22':{valid_from:'2027-02-05',valid_to:'2027-02-15',price:11,currency_id:157}}]});
  await send(access,'upgrade',[upgraded],'request-upgrade');await process(worker);
  const projection=(await db.query('SELECT * FROM memberships')).rows[0];assert.equal(projection.payload.first_name,'Jane');assert.equal(projection.payload.upgrades[0]['22'].price,11);
  const cancellation={business_id:'111',plan_id:'999',issued_country:'14',membership_number:'MEM001'};
  const cancelled=await send(access,'cancel',cancellation,'request-cancel');assert.equal(cancelled.statusCode,202);await worker.tick();
  assert.equal((await db.query('SELECT status FROM memberships')).rows[0].status,'cancelled');
  assert.equal((await db.query('SELECT count(*)::int n FROM operations WHERE status=$1',['finished'])).rows[0].n,4);
});
test('fallo atómico de Audax marca todos los registros; no crea memberships parciales',async()=>{
  const access=await token(await createClient());await send(access,'insert',[sample({membership_number:'MOCK-FAIL-1'}),sample({membership_number:'OK-2'})]);await process();
  assert.equal((await db.query('SELECT status FROM operations')).rows[0].status,'failed');
  assert.deepEqual((await db.query('SELECT status FROM operation_items')).rows.map(r=>r.status),['failed','failed']);
  assert.equal((await db.query('SELECT count(*)::int n FROM memberships')).rows[0].n,0);
});
test('un cliente no puede ver procesos ajenos ni usar un token de otro ambiente',async()=>{
  const a=await createClient(),b=await createClient({name:'B',company_name:'B'}),ta=await token(a),tb=await token(b);
  const op=await send(ta,'insert',[sample()]);
  assert.equal((await inject({url:`/api/GetProcessStatus/${op.json().ProcessID}`,headers:{authorization:`Bearer ${tb}`}})).statusCode,404);
  await db.query("UPDATE access_tokens SET environment='prod' WHERE client_id=$1",[a.id]);assert.equal((await send(ta,'insert',[sample()],'request-env')).statusCode,401);
});
test('timeout incierto no reenvía y bloquea cambios posteriores de la misma membership',async()=>{
  const access=await token(await createClient());await send(access,'insert',[sample()]);await send(access,'update',[sample({first_name:'Cambio'})],'request-second');
  let sends=0;const uncertain={submit:async()=>{sends++;throw new AudaxError('timeout',{uncertain:true})}};
  const worker=new Worker(db,uncertain,config);await worker.tick();await worker.tick();await worker.tick();assert.equal(sends,1);
  assert.deepEqual((await db.query('SELECT status FROM operations ORDER BY seq')).rows.map(r=>r.status),['unknown','queued']);
});
test('recuperación de lease de envío nunca duplica el POST; lease de consulta es recuperable',async()=>{
  const access=await token(await createClient()),a=await send(access,'insert',[sample()]);
  await db.query("UPDATE operations SET status='sending',lease_id=id,lease_until=now()-interval '1 minute' WHERE id=$1",[a.json().ProcessID]);
  await new Worker(db,gateway,config).tick();assert.equal((await db.query('SELECT status FROM operations')).rows[0].status,'unknown');
  assert.equal((await db.query('SELECT status FROM operation_items')).rows[0].status,'unknown');
});
test('worker no envía pendientes después de una baja del cliente',async()=>{
  const c=await createClient(),access=await token(c);await send(access,'insert',[sample()]);
  await inject({method:'DELETE',url:`/admin/clients/${c.id}`,headers:adminHeaders});let calls=0;
  await new Worker(db,{submit:async()=>{calls++}},config).tick();assert.equal(calls,0);assert.equal((await db.query('SELECT status FROM operations')).rows[0].status,'failed');
});
test('429 conserva el trabajo y respeta Retry-After; luego puede enviarse una sola vez',async()=>{
  const access=await token(await createClient());await send(access,'insert',[sample()]);let calls=0;
  const adapter={submit:async op=>{calls++;if(calls===1)throw new AudaxError('rate limit',{status:429,retryable:true,retryAfter:60000});return gateway.submit(op)},poll:id=>gateway.poll(id)};
  const worker=new Worker(db,adapter,config);await worker.tick();const op=(await db.query('SELECT * FROM operations')).rows[0];assert.equal(op.status,'queued');assert.ok(new Date(op.next_attempt_at).valueOf()>Date.now()+55000);
  await worker.tick();assert.equal(calls,1);await db.query('UPDATE operations SET next_attempt_at=now()');await process(worker);assert.equal(calls,2);assert.equal((await db.query('SELECT status FROM operations')).rows[0].status,'finished');
});
test('error de persistencia posterior a respuesta no se convierte en rechazo ni reenvío',async()=>{
  const access=await token(await createClient());await send(access,'insert',[sample()]);
  const worker=new Worker(db,gateway,config);worker.finish=async()=>{throw new Error('database unavailable')};await assert.rejects(worker.tick(),/database unavailable/);
  assert.equal((await db.query('SELECT status FROM operations')).rows[0].status,'sending');
});
test('conciliación vuelve a consultar un ProcessID verificado sin reenviar el lote',async()=>{
  const access=await token(await createClient()),result=await send(access,'insert',[sample()]);const id=result.json().ProcessID;
  const op=(await db.query('SELECT * FROM operations WHERE id=$1',[id])).rows[0];const remote=await gateway.submit(op);
  await db.query("UPDATE operations SET status='unknown',tracking_started_at=now()-interval '2 days' WHERE id=$1",[id]);
  const r=await inject({method:'POST',url:`/admin/operations/${id}/reconcile`,headers:adminHeaders,payload:{audax_process_id:remote.processId}});assert.equal(r.statusCode,200,r.body);
  await new Worker(db,gateway,config).tick();assert.equal((await db.query('SELECT status FROM operations WHERE id=$1',[id])).rows[0].status,'finished');
  assert.equal((await db.query('SELECT count(*)::int n FROM mock_processes')).rows[0].n,1);
});
test('producción exige conexión real, HTTPS y PostgreSQL; URLs no se cruzan',()=>{
  assert.throws(()=>configFromEnv({APP_ENV:'prod'}),/Producción requiere/);
  const prod=configFromEnv({APP_ENV:'prod',AUDAX_MODE:'live',COOKIE_SECURE:'true',PUBLIC_ORIGIN:'https://api.example.com',DATABASE_URL:'postgresql://configured',AUDAX_CLIENT_ID:'id',AUDAX_CLIENT_SECRET:'secret',AUDAX_SCOPE:'scope'});
  assert.equal(prod.audaxBaseUrl,AUDAX_URLS.prod);assert.notEqual(prod.audaxBaseUrl,config.audaxBaseUrl);
  assert.equal(configFromEnv({APP_ENV:'test',AUDAX_MODE:'live'}).useCatalogs,true);
});
test('adaptador real usa token Microsoft, rutas documentadas, DELETE con body y refresh 401',async()=>{
  const calls=[];let mutation=0;
  const fake=async(url,options)=>{calls.push({url,...options});if(url===config.audaxTokenUrl)return new Response(JSON.stringify({access_token:`remote-${calls.length}`,expires_in:3600}),{status:200});if(++mutation===1)return new Response('{}',{status:401});return new Response(options.method==='DELETE'?'':JSON.stringify({ProcessID:'remote-process'}),{status:200})};
  const live=new LiveAudax({...config,audaxClientId:'official-id',audaxClientSecret:'official-secret',audaxScope:'official-scope'},fake);
  await live.submit({kind:'upgrade',payload:[sample({upgrades:[{'22':{valid_from:'2027-02-05',valid_to:'2027-02-15'}}]})]});
  assert.equal(calls.filter(c=>c.url===config.audaxTokenUrl).length,2);
  const request=calls.find(c=>c.url.endsWith('/UpdateMembershipBatch'));assert.equal(request.method,'POST');assert.equal(JSON.parse(request.body)[0].upgrades[0]['22'].valid_from,'2027-02-05');
  assert.equal(calls[0].body.get('grant_type'),'client_credentials');assert.equal(calls[0].body.get('scope'),'official-scope');
  await live.submit({kind:'cancel',payload:{membership_number:'MEM001'}});assert.equal(calls.at(-1).method,'DELETE');assert.ok(calls.at(-1).url.endsWith('/CancelMembership'));assert.equal(JSON.parse(calls.at(-1).body).membership_number,'MEM001');
});
test('adaptador real clasifica 500/timeout como incierto y un 400 como rechazo',async()=>{
  for(const code of [400,500,408,429]){
    const adapter=new LiveAudax(config,async url=>new Response(JSON.stringify(url===config.audaxTokenUrl?{access_token:'token'}:{errors:'upstream'}),{status:url===config.audaxTokenUrl?200:code}));
    await assert.rejects(adapter.submit({kind:'insert',payload:[sample()]}),error=>{assert.equal(error.uncertain,[500,408].includes(code));assert.equal(error.retryable,code===429);return true});
  }
});
test('upgrades embebidos no evaden scopes y override requiere doble habilitación',async()=>{
  const c=await createClient(),access=await token(c,'memberships:insert memberships:update');
  const upgradePayload=sample({upgrades:[{'22':{valid_from:'2027-02-05',valid_to:'2027-02-15'}}]});
  assert.equal((await send(access,'insert',[upgradePayload])).statusCode,403);
  assert.equal((await send(await token(c),'update',[sample({override:true})])).statusCode,403);
  assert.throws(()=>validatePayload('update',[sample({override:true})],clientBody({scopes:['memberships:update']}),500,true),/Override requiere/);
  assert.equal(validatePayload('update',[sample({override:true})],clientBody(),500,true).payload[0].override,true);
  assert.throws(()=>validatePayload('insert',[sample({override:false})],clientBody(),500,true),/solo está documentado/);
});
test('dos workers no reclaman un mismo envío y se conserva el orden por membership',async()=>{
  const access=await token(await createClient());await send(access,'insert',[sample()]);await send(access,'update',[sample({first_name:'Después'})],'ordered-update');
  const a=new Worker(db,gateway,config),b=new Worker(db,gateway,config);
  const claimed=await Promise.all([a.claim(),b.claim()]);assert.equal(claimed.filter(Boolean).length,1);
  const op=claimed.find(Boolean);await a.finish(op,'finished');
  const next=await b.claim();assert.equal(next.kind,'update');
});
test('consulta con lease vencido se recupera sin repetir el envío',async()=>{
  const access=await token(await createClient());await send(access,'insert',[sample()]);const worker=new Worker(db,gateway,config);await worker.tick();
  await db.query("UPDATE operations SET lease_id=id,lease_until=now()-interval '1 minute' WHERE status='submitted'");await worker.tick();
  assert.equal((await db.query('SELECT status FROM operations')).rows[0].status,'finished');assert.equal((await db.query('SELECT count(*)::int n FROM mock_processes')).rows[0].n,1);
});
test('archivos privados y rutas arbitrarias nunca se sirven desde el panel',async()=>{
  for(const url of ['/.env','/src/config.mjs','/migrations/001_initial.sql','/..%2f.env','/%2e%2e%2f.env']){
    const response=await inject({url});assert.ok(response.statusCode>=400,`${url}: ${response.statusCode}`);
  }
  const html=await inject({url:'/'});assert.equal(html.statusCode,200);assert.match(html.headers['content-type'],/text\/html/);assert.ok(html.headers['content-security-policy'].includes("frame-ancestors 'none'"));
});
test('token expirado se rechaza y catálogos se filtran por empresa',async()=>{
  const c=await createClient(),access=await token(c);
  const catalog=await inject({url:'/api/GetUpgrades',headers:{authorization:`Bearer ${access}`}});assert.deepEqual(catalog.json(),{});
  await db.query("UPDATE access_tokens SET expires_at=now()-interval '1 minute'");assert.equal((await send(access,'insert',[sample()])).statusCode,401);
});
test('el alias de upgrade no permite modificar datos sin scope de update',async()=>{
  const c=await createClient(),access=await token(c,'memberships:upgrade');
  const r=await send(access,'upgrade',[sample({upgrades:[{'22':{valid_from:'2027-02-05',valid_to:'2027-02-15'}}]})]);assert.equal(r.statusCode,403);
});
