/** Verifica aislamiento físico y de autenticación sin usar servidores oficiales. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {configFromEnv,AUDAX_URLS} from '../src/config.mjs';
import {openDatabase} from '../src/db.mjs';
import {createServices} from '../src/services.mjs';
import {buildApp} from '../src/app.mjs';

test('bases gemelas independientes: PROD vacío, sesiones aisladas y URL oficial propia',async()=>{
  const common={LOCAL_DATA_DIR:':memory:',CONFIG_ENCRYPTION_KEY:randomBytes(32).toString('hex'),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'isolated-env-admin-password'};
  const testConfig=configFromEnv({...common,APP_ENV:'test',PUBLIC_ORIGIN:'http://127.0.0.1:3000'});
  const prodConfig=configFromEnv({...common,APP_ENV:'prod',LOCAL_PREVIEW:'true',PORT:'3001',PUBLIC_ORIGIN:'http://127.0.0.1:3001'});
  const testDb=await openDatabase(testConfig),prodDb=await openDatabase(prodConfig);let testApp,prodApp;
  const noNetwork=async()=>{throw new Error('Unexpected official call')};
  try{
    const testServices=await createServices(testDb,testConfig,noNetwork),prodServices=await createServices(prodDb,prodConfig,noNetwork);
    testApp=await buildApp({db:testDb,config:testConfig,...testServices});prodApp=await buildApp({db:prodDb,config:prodConfig,...prodServices});
    await testServices.settings.save({client_id:'test-only',client_secret:'test-only-secret',scope:'scope',revision:0},'admin');
    const prodState=await prodServices.settings.status();assert.equal(prodState.configured,false);assert.equal(prodState.base_url,AUDAX_URLS.prod);assert.equal(prodState.environment,'prod');
    assert.equal((await testServices.settings.status()).base_url,AUDAX_URLS.test);
    assert.equal((await prodDb.query('SELECT count(*)::int n FROM clients')).rows[0].n,0);
    assert.equal((await prodDb.query('SELECT count(*)::int n FROM operations')).rows[0].n,0);
    const tables=async db=>(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")).rows;
    assert.deepEqual(await tables(testDb),await tables(prodDb));
    const login=await testApp.inject({method:'POST',url:'/admin/login',payload:{username:'admin',password:common.ADMIN_PASSWORD}});
    assert.equal((await prodApp.inject({url:'/admin/session',headers:{cookie:login.headers['set-cookie'].split(';')[0]}})).statusCode,401);
    await assert.rejects(prodServices.settings.save({client_id:'prod',client_secret:'secret',scope:'scope',revision:0},'admin'),/PROD local/);
    assert.equal(await prodServices.gateway.isReady(),false);
    const config=(await prodApp.inject({url:'/public/config'})).json();assert.equal(config.environment,'prod');assert.equal(config.portal_urls.test,'http://127.0.0.1:3000');
  }finally{await testApp?.close();await prodApp?.close();await testDb.close();await prodDb.close();}
});

test('PROD desplegado permite configuración pendiente pero exige PostgreSQL y HTTPS',()=>{
  const prod=configFromEnv({APP_ENV:'prod',DATABASE_URL:'postgresql://configured',COOKIE_SECURE:'true',PUBLIC_ORIGIN:'https://prod.example.com'});
  assert.equal(prod.useCatalogs,true);assert.equal(prod.audaxBaseUrl,AUDAX_URLS.prod);assert.equal(prod.audaxClientSecret,'');
  assert.throws(()=>configFromEnv({APP_ENV:'prod',LOCAL_PREVIEW:'true',HOST:'0.0.0.0',PUBLIC_ORIGIN:'http://127.0.0.1:3001'}),/loopback/);
  assert.throws(()=>configFromEnv({APP_ENV:'prod',LOCAL_PREVIEW:'true',PUBLIC_ORIGIN:'http://127.0.0.1:3001',AUDAX_CLIENT_SECRET:'secret'}),/credenciales/);
  assert.throws(()=>configFromEnv({APP_ENV:'prod',PUBLIC_ORIGIN:'http://127.0.0.1:3001'}),/Producción requiere/);
});

test('servicios PROD configurables usan exclusivamente Audax PROD y cifrado ligado al ambiente',async()=>{
  const preview=configFromEnv({APP_ENV:'prod',LOCAL_PREVIEW:'true',LOCAL_DATA_DIR:':memory:',PUBLIC_ORIGIN:'http://127.0.0.1:3001',CONFIG_ENCRYPTION_KEY:randomBytes(32).toString('hex')});
  const db=await openDatabase(preview),urls=[];
  try{
    const config={...preview,localPreview:false};
    const services=await createServices(db,config,async url=>{urls.push(url);return Response.json(url===config.audaxTokenUrl?{access_token:'prod-token',expires_in:3600}:[])});
    await services.settings.save({client_id:'prod-client',client_secret:'prod-secret',scope:'prod-scope',revision:0},'admin');
    await services.settings.test('admin');assert.ok(urls.includes(AUDAX_URLS.prod+'/GetBusiness'));assert.ok(!urls.some(url=>url.startsWith(AUDAX_URLS.test)));
    assert.equal((await services.settings.record()).environment,'prod');
  }finally{await db.close();}
});
