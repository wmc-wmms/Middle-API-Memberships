import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {configFromEnv,AUDAX_URLS} from '../src/config.mjs';
import {openDatabase} from '../src/db.mjs';
import {buildApp} from '../src/app.mjs';
import {createServices} from '../src/services.mjs';
import {Worker} from '../src/worker.mjs';
import {normalizeCatalog} from '../src/catalogs.mjs';
const config={...configFromEnv({AUDAX_MODE:'live',LOCAL_DATA_DIR:':memory:',CONFIG_ENCRYPTION_KEY:randomBytes(32).toString('hex'),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'integration-test-password-long'}),pollMs:0};
const catalogs={GetBusiness:[{business_id:'30',name:'ASSIST 365'},{business_id:'40',name:'Otra empresa'}],GetPlans:{'30':[{membership_plan_id:'1139',name:'ELITE COVER (A)'},{membership_plan_id:'1140',name:'ESSENTIAL TRIP (A)'}],'40':[{membership_plan_id:'2000',name:'Otro plan'}]},GetCountries:[{country_id:'14',name:'Argentina',iso3166:'AR'}],GetCurrencies:[{currency_id:'157',name:'USD',iso4217:'USD'}],GetLocationGroups:[{location_group_id:'1',name:'Mundial'}],GetConditions:[{condition_id:'90',name:'Condición'}],GetUpgrades:{'30':[{upgrade_id:'22',condition_id:'90',rules:[]}]}};
let db,app,services,worker,headers,client,failEndpoint='',calls=[];
const fetcher=async(url,options)=>{
  calls.push({url,options});
  if(url===config.audaxTokenUrl){const form=new URLSearchParams(options.body);assert.equal(form.get('client_secret'),'official-test-secret');return Response.json({access_token:'test-token',expires_in:3600});}
  assert.ok(url.startsWith(AUDAX_URLS.test+'/'));assert.equal(options.headers.Authorization,'Bearer test-token');
  const endpoint=url.slice(AUDAX_URLS.test.length+1);
  if(endpoint===failEndpoint)return Response.json({error:'provider-private-error'},{status:500});
  if(catalogs[endpoint]){assert.equal(options.method,'GET');assert.equal(options.body,undefined);return Response.json(catalogs[endpoint]);}
  if(endpoint.startsWith('GetProcessStatus/'))return Response.json({id:endpoint.split('/')[1],status:'finished'});
  if(endpoint==='CancelMembership')return Response.json({ok:true});
  if(['InsertMembershipBatch','UpdateMembershipBatch'].includes(endpoint))return Response.json({ProcessID:randomUUID()});
  throw new Error('Unexpected endpoint '+endpoint);
};
const request=(method,url,payload,key)=>app.inject({method,url,headers:{...headers,...(key?{'idempotency-key':key}:{})},...(payload?{payload}:{})});
const membership=(extra={})=>({business_id:'30',plan_id:'1139',membership_number:'MANUAL-001',national_id:'AB123',last_name:'Doe',first_name:'Jane',issued_country:'14',date_of_birth:'1980-05-15',issued_date:'2027-01-01',valid_from:'2027-02-01',valid_to:'2027-03-01',max_consecutive_days_per_trip:30,price:10,currency_id:'157',...extra});
before(async()=>{db=await openDatabase(config);services=await createServices(db,config,fetcher);app=await buildApp({db,config,...services});worker=new Worker(db,services.gateway,config,services.catalogs);const login=await app.inject({method:'POST',url:'/admin/login',payload:{username:'admin',password:config.adminPassword}});assert.equal(login.statusCode,200,login.body);headers={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.json().csrf_token};});
after(async()=>{await app?.close();await db?.close();});
test('GetPlans agrupa por business, admite planes compartidos y rechaza estructuras ambiguas',()=>{
  const rows=normalizeCatalog('plans',{'30':[{membership_plan_id:'1139',name:'ELITE'}],'40':[{membership_plan_id:'1139',name:'ELITE'}]});
  assert.equal(rows.length,1);assert.deepEqual(rows[0].data.business_ids,['30','40']);
  for(const input of [[],{'30':{}},{'30':[{},{}]},{'30':[{membership_plan_id:'1',name:'A'},{membership_plan_id:'1',name:'A'}]},{'30':[{membership_plan_id:'1',name:'A'}],'40':[{membership_plan_id:'1',name:'B'}]}])assert.throws(()=>normalizeCatalog('plans',input));
});
test('credenciales TEST cifradas, CSRF, revisión concurrente y verificación real mediante adaptador',async()=>{
  assert.equal((await services.settings.status()).configured,false);assert.equal(await worker.tick(),false);assert.equal(calls.length,0);
  assert.equal((await app.inject({method:'PUT',url:'/admin/audax/settings',headers:{cookie:headers.cookie},payload:{}})).statusCode,403);
  const saved=await request('PUT','/admin/audax/settings',{client_id:'official-client',client_secret:'official-test-secret',scope:'api/.default',revision:0});assert.equal(saved.statusCode,200,saved.body);assert.ok(!saved.body.includes('official-test-secret'));
  const record=await services.settings.record();assert.notEqual(record.secret_encrypted,'official-test-secret');assert.equal(services.settings.decrypt(record.secret_encrypted,record.fingerprint),'official-test-secret');
  assert.equal((await request('PUT','/admin/audax/settings',{client_id:'official-client',scope:'api/.default',revision:0})).statusCode,409);
  assert.equal((await request('PUT','/admin/audax/settings',{client_id:'official-client',scope:'api/.default',client_secret:'',revision:1})).statusCode,200);
  assert.equal((await request('POST','/admin/audax/test')).statusCode,200);assert.ok((await services.settings.status()).verified_at);
});
test('sincroniza seis catálogos y relaciones agrupadas automáticamente sin asociaciones manuales',async()=>{
  const r=await request('POST','/admin/catalogs/sync');assert.equal(r.statusCode,202,r.body);await worker.tick();
  const s=await services.catalogs.snapshot();assert.equal(s.last_run.status,'finished');assert.equal(s.catalogs.plans.length,3);
  assert.deepEqual(s.business_plans.map(p=>[p.business_id,p.plan_id,p.source]),[['30','1139','audax'],['30','1140','audax'],['40','2000','audax']]);
  for(const type of ['business','countries','currencies','locations','conditions','upgrades'])assert.ok(s.catalogs[type].length);
  assert.equal((await request('PUT','/admin/catalogs/business/30/plans',{plan_ids:['2000']})).statusCode,404);
});
test('sincronización fallida conserva catálogos anteriores y rechaza business desconocido',async()=>{
  failEndpoint='GetCountries';await services.catalogs.requestSync('admin');await services.catalogs.tick();let s=await services.catalogs.snapshot();assert.equal(s.last_run.status,'failed');assert.equal(s.catalogs.plans.length,3);assert.ok(!JSON.stringify(s).includes('provider-private-error'));failEndpoint='';
  catalogs.GetPlans['99']=[];await services.catalogs.requestSync('admin');await services.catalogs.tick();s=await services.catalogs.snapshot();assert.equal(s.last_run.status,'failed');assert.equal(s.business_plans.length,3);delete catalogs.GetPlans['99'];
  await services.catalogs.requestSync('admin');await services.catalogs.tick();assert.equal((await services.catalogs.snapshot()).last_run.status,'finished');
});
test('usuarios solo aceptan pares oficiales y carga manual valida empresa, país y moneda',async()=>{
  const body={name:'Integración TEST',company_name:'ASSIST 365',email:'',business_ids:['30','40'],plan_ids:['1139','2000'],business_plan_pairs:[{business_id:'30',plan_id:'1139'},{business_id:'40',plan_id:'2000'}],scopes:['memberships:read','memberships:insert','memberships:update','memberships:upgrade','memberships:cancel'],active:true};
  const invalid=await request('POST','/admin/clients',{...body,business_plan_pairs:[{business_id:'30',plan_id:'2000'},{business_id:'40',plan_id:'1139'}]});assert.equal(invalid.statusCode,400,invalid.body);
  const created=await request('POST','/admin/clients',body);assert.equal(created.statusCode,201,created.body);client=created.json();
  for(const [extra,status] of [[{business_id:'40',plan_id:'1139'},403],[{issued_country:'ZZ'},400],[{currency_id:'ZZ'},400]]){const r=await request('POST','/admin/memberships/manual',{client_id:client.id,kind:'insert',membership:membership(extra)},randomUUID());assert.equal(r.statusCode,status,r.body);}
});
test('carga manual persiste, es idempotente y envía altas, update, upgrades y baja a rutas TEST',async()=>{
  for(const kind of ['insert','update','upgrade','cancel']){
    const item=kind==='cancel'?{business_id:'30',plan_id:'1139',issued_country:'14',membership_number:'MANUAL-001'}:membership(kind==='upgrade'?{upgrades:[{'22':{valid_from:'2027-02-05',valid_to:'2027-02-15',currency_id:'157',price:5}}]}:{});
    const body={client_id:client.id,kind,membership:item},key=randomUUID();
    const r=await request('POST','/admin/memberships/manual',body,key);assert.equal(r.statusCode,202,r.body);
    const replay=await request('POST','/admin/memberships/manual',body,key);assert.equal(replay.json().ProcessID,r.json().ProcessID);
    const row=(await db.query('SELECT * FROM operations WHERE id=$1',[r.json().ProcessID])).rows[0];assert.equal(row.source,'manual');assert.equal(row.created_by,'admin');assert.equal(row.audax_mode,'live');assert.ok(row.connection_fingerprint);
    const setting=await services.settings.status();assert.equal((await request('PUT','/admin/audax/settings',{client_id:'other',client_secret:'new-secret',scope:'api/.default',revision:setting.revision})).statusCode,409);
    await worker.tick();await worker.tick();
    assert.equal((await db.query('SELECT status FROM operations WHERE id=$1',[row.id])).rows[0].status,'finished');
    const sent=calls.filter(c=>c.options.method===(kind==='cancel'?'DELETE':'POST')&&c.url.startsWith(AUDAX_URLS.test)).at(-1);
    assert.deepEqual(JSON.parse(sent.options.body),kind==='cancel'?item:[item]);
  }
  const rows=(await request('GET','/admin/memberships')).json();assert.equal(rows.length,1);assert.equal(rows[0].status,'cancelled');
});
test('resincronización elimina relaciones retiradas y conserva el último catálogo si falla',async()=>{
  catalogs.GetPlans['30']=[];await services.catalogs.requestSync('admin');await services.catalogs.tick();const s=await services.catalogs.snapshot();assert.equal(s.catalogs.plans.length,1);assert.equal(s.business_plans.length,1);
  const r=await request('POST','/admin/memberships/manual',{client_id:client.id,kind:'insert',membership:membership({membership_number:'REMOVED-PLAN'})},randomUUID());assert.equal(r.statusCode,400,r.body);
});

test('colección descargable tiene URL, scope y variables; no requiere ambiente extra ni expone secretos',async()=>{
  assert.equal((await app.inject({url:'/admin/downloads/postman_collection.json'})).statusCode,401);
  const r=await request('GET','/admin/downloads/postman_collection.json');assert.equal(r.statusCode,200,r.body);
  assert.match(r.headers['content-disposition'],/attachment/);
  const c=r.json(),variables=Object.fromEntries(c.variable.map(v=>[v.key,v.value]));
  assert.equal(variables.base_url,config.publicOrigin);assert.equal(variables.client_secret,'');
  assert.equal(variables.scope,'memberships:read memberships:insert memberships:update memberships:upgrade memberships:cancel');
  assert.ok(!r.body.includes('official-test-secret'));
  assert.ok(c.item.find(i=>i.name==='Insert').event.some(e=>e.listen==='prerequest'));
  for(const file of ['postman_test.environment.json','postman_prod.environment.json','openapi.json'])assert.equal((await request('GET','/admin/downloads/'+file)).statusCode,200);
  assert.equal((await request('GET','/admin/downloads/.env')).statusCode,400);
});

test('después de recibir un alta sigue hasta el resultado sin verificar catálogos ni conexión nuevamente',async()=>{
  catalogs.GetPlans['30']=[{membership_plan_id:'1139',name:'ELITE COVER (A)'}];await services.catalogs.requestSync('admin');await services.catalogs.tick();
  const sent=await request('POST','/admin/memberships/manual',{client_id:client.id,kind:'insert',membership:membership({membership_number:'AUTO-RESULT'})},randomUUID());assert.equal(sent.statusCode,202,sent.body);
  await db.query('UPDATE audax_settings SET verified_at=NULL WHERE id=1');
  const start=calls.length;
  await worker.tick();await worker.tick();
  const row=(await db.query('SELECT * FROM operations WHERE id=$1',[sent.json().ProcessID])).rows[0];assert.equal(row.status,'finished');
  assert.ok(!calls.slice(start).some(c=>Object.keys(catalogs).some(endpoint=>c.url.endsWith('/'+endpoint))));
  const diagnostic=await request('GET','/admin/audax/process/'+row.audax_process_id);assert.equal(diagnostic.statusCode,200,diagnostic.body);assert.equal(diagnostic.json().status,'finished');
  assert.equal(diagnostic.json().local_operations[0].id,row.id);
  const other=await request('GET','/admin/audax/process/'+randomUUID());assert.deepEqual(other.json().local_operations,[]);
  const activity=await request('GET','/admin/membership-activity?search=AUTO-RESULT');assert.equal(activity.json()[0].status,'finished');
  await db.query('UPDATE audax_settings SET verified_at=now() WHERE id=1');
});
