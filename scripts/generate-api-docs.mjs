import { mkdir, writeFile } from 'node:fs/promises';
const sample = { plan_id:'999',membership_number:'MEM-001',national_id:'AB123456',business_id:'111',last_name:'Doe',first_name:'John',issued_country:'14',date_of_birth:'1980-05-15',issued_date:'2027-01-01',valid_from:'2027-02-01',valid_to:'2027-03-01',max_consecutive_days_per_trip:30,price:10,currency_id:'157' };
const upgrade = { '22': { valid_from:'2027-02-05',valid_to:'2027-02-15',price:11,currency_id:'157' } };
const cancel = { business_id:'111',plan_id:'999',issued_country:'14',membership_number:'MEM-001' };
const id = { type:'string',minLength:1,maxLength:128 };
const date = { type:'string',format:'date' };
const money = { price:{type:'number',exclusiveMinimum:0},currency_id:{oneOf:[id,{type:'integer',minimum:1}]} };
const up = {type:'object',additionalProperties:false,required:['valid_from','valid_to'],properties:{valid_from:date,valid_to:date,...money}};
const membership = {type:'object',additionalProperties:false,required:['plan_id','membership_number','national_id','business_id','last_name','first_name','issued_country','date_of_birth','issued_date','valid_from','valid_to','max_consecutive_days_per_trip'],properties:{
  plan_id:id,membership_number:id,national_id:id,business_id:id,last_name:{type:'string',minLength:1,maxLength:200},first_name:{type:'string',minLength:1,maxLength:200},issued_country:id,date_of_birth:date,issued_date:date,valid_from:date,valid_to:date,max_consecutive_days_per_trip:{type:'integer',minimum:1,maximum:2147483647},...money,
  upgrades:{type:'array',maxItems:100,items:{type:'object',minProperties:1,maxProperties:1,additionalProperties:{$ref:'#/components/schemas/Upgrade'}}},
}};
const scopes = Object.fromEntries(['read','insert','update','upgrade','cancel','override'].map(s=>[`memberships:${s}`,s]));
const errorResponse = {description:'Error de validación, autenticación o autorización',content:{'application/json':{schema:{type:'object',properties:{error:{type:'string'},message:{type:'string'},details:{}}}}}};
const idempotency = {name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:8,maxLength:128,pattern:'^[!-~]+$'},description:'Única por cliente y operación lógica. Reutilizar al repetir el mismo envío.'};
const spec = {openapi:'3.1.0',info:{title:'Audax Membership Gateway',version:'1.0.0',description:'API pública del middleware. Recepción persistente y procesamiento asíncrono. ProcessID es local. Cancel devuelve 202; se consulta por GetProcessStatus. Upgrades se remiten a UpdateMembershipBatch de Audax.'},servers:[{url:'http://127.0.0.1:3000',description:'TEST local'}],paths:{},components:{securitySchemes:{oauth:{type:'oauth2',flows:{clientCredentials:{tokenUrl:'/oauth/token',scopes}}},basic:{type:'http',scheme:'basic'}},schemas:{
  Upgrade:up,InsertMembership:membership,
  UpdateMembership:{...membership,properties:{...membership.properties,override:{type:'boolean',default:false}}},
  UpgradeMembership:{...membership,required:[...membership.required,'upgrades'],properties:{...membership.properties,upgrades:{...membership.properties.upgrades,minItems:1},override:{type:'boolean',default:false}}},
  Cancellation:{type:'object',additionalProperties:false,required:Object.keys(cancel),properties:{business_id:id,plan_id:id,issued_country:id,membership_number:id,override:{type:'boolean',default:false}}},
  Receipt:{type:'object',required:['ProcessID'],properties:{ProcessID:{type:'string',format:'uuid'}}},
  ProcessStatus:{type:'object',required:['id','status','middleware_status'],properties:{id:{type:'string',format:'uuid'},status:{enum:['processing','finished','failed','unknown']},middleware_status:{enum:['queued','sending','submitted','finished','failed','unknown']},audax_process_id:{type:['string','null']},errors:{},items:{type:'array',items:{type:'object'}}}},
}}};
spec.paths['/oauth/token']={post:{summary:'Obtener token de una hora',security:[{basic:[]},{}],requestBody:{required:true,content:{'application/x-www-form-urlencoded':{schema:{type:'object',required:['grant_type'],properties:{grant_type:{const:'client_credentials'},client_id:{type:'string'},client_secret:{type:'string',writeOnly:true},scope:{type:'string'}}}}}},responses:{200:{description:'Token Bearer opaco',content:{'application/json':{schema:{type:'object',properties:{access_token:{type:'string'},token_type:{const:'Bearer'},expires_in:{type:'integer'},scope:{type:'string'}}}}}},400:errorResponse,401:errorResponse,429:errorResponse}}};
for(const [kind,path,schema,method,example] of [
  ['insert','InsertMembershipBatch','InsertMembership','post',[sample]],
  ['update','UpdateMembershipBatch','UpdateMembership','post',[{...sample,first_name:'Jane'}]],
  ['upgrade','UpgradeMembershipBatch','UpgradeMembership','post',[{...sample,upgrades:[upgrade]}]],
  ['cancel','CancelMembership','Cancellation','delete',cancel],
]){
  spec.paths[`/api/${path}`]={[method]:{summary:kind,description:'Recibe y guarda antes de enviar. Si el payload contiene upgrades se requiere además memberships:upgrade; override=true requiere memberships:override, habilitación del servidor y permiso oficial de Audax. Update no modifica el precio oficial.',security:[{oauth:kind==='upgrade'?['memberships:upgrade','memberships:update']:[`memberships:${kind}`]}],parameters:[idempotency],requestBody:{required:true,content:{'application/json':{schema:kind==='cancel'?{$ref:`#/components/schemas/${schema}`}:{type:'array',minItems:1,maxItems:500,items:{$ref:`#/components/schemas/${schema}`}},example}}},responses:{[kind==='cancel'?202:200]:{description:'Recepción local confirmada, no aceptación final de Audax',content:{'application/json':{schema:{$ref:'#/components/schemas/Receipt'}}}},400:errorResponse,401:errorResponse,403:errorResponse,409:errorResponse,413:errorResponse,429:errorResponse}}};
}
spec.paths['/api/GetProcessStatus/{ProcessID}']={get:{summary:'Consultar proceso local',security:[{oauth:['memberships:read']}],parameters:[{name:'ProcessID',in:'path',required:true,schema:{type:'string',format:'uuid'}}],responses:{200:{description:'Estado y resultado del lote',content:{'application/json':{schema:{$ref:'#/components/schemas/ProcessStatus'}}}},401:errorResponse,404:errorResponse}}};
spec.paths['/api/GetUpgrades']={get:{summary:'Catálogo de upgrades por empresas habilitadas',security:[{oauth:['memberships:read']}],responses:{200:{description:'Objeto indexado por business ID',content:{'application/json':{schema:{type:'object',additionalProperties:{type:'array',items:{type:'object'}}}}}},502:errorResponse}}};
spec.paths['/api/memberships'] = {
  get: {
    summary: 'Última solicitud confirmada por membership (no precio ni snapshot oficial)',
    security: [{ oauth: ['memberships:read'] }],
    parameters: [{ name:'offset', in:'query', schema:{ type:'integer',minimum:0,maximum:1000000,default:0 } }],
    responses: {
      200: {
        description: 'Hasta 100 registros',
        content: { 'application/json': { schema: {
          type:'array', items: { type:'object', properties: {
            last_confirmed_request:{type:'object'},status:{enum:['active','cancelled']},updated_at:{type:'string',format:'date-time'},
          } },
        } } },
      },
    },
  },
};
const collection={info:{name:'Audax · Middleware',schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',description:'Importar esta colección y completar client_id y client_secret. URL y scope incluidos; ambientes opcionales. No contiene secretos. Las claves de idempotencia se conservan: cambiar la variable correspondiente solo para una NUEVA operación.'},variable:Object.entries({base_url:'http://127.0.0.1:3000',client_id:'',client_secret:'',scope:'memberships:read memberships:insert memberships:update memberships:upgrade memberships:cancel',access_token:'',process_id:'',insert_key:'',update_key:'',upgrade_key:'',cancel_key:''}).map(([key,value])=>({key,value,type:'string'})),item:[]};
collection.item.push({name:'Obtener token',request:{method:'POST',header:[{key:'Content-Type',value:'application/x-www-form-urlencoded'}],body:{mode:'urlencoded',urlencoded:[['grant_type','client_credentials'],['client_id','{{client_id}}'],['client_secret','{{client_secret}}'],['scope','{{scope}}']].map(([key,value])=>({key,value,type:'text'}))},url:'{{base_url}}/oauth/token'},event:[{listen:'test',script:{type:'text/javascript',exec:["pm.test('Token generado', () => pm.response.to.have.status(200));","if (pm.response.code === 200) pm.collectionVariables.set('access_token', pm.response.json().access_token);"]}}]});
for(const [name,path,method,body,key] of [
  ['Insert','InsertMembershipBatch','POST',[sample],'insert_key'],['Update','UpdateMembershipBatch','POST',[{...sample,first_name:'Jane'}],'update_key'],['Upgrade','UpgradeMembershipBatch','POST',[{...sample,upgrades:[upgrade]}],'upgrade_key'],['Baja','CancelMembership','DELETE',cancel,'cancel_key'],
])collection.item.push({name,request:{method,header:[{key:'Authorization',value:'Bearer {{access_token}}'},{key:'Content-Type',value:'application/json'},{key:'Idempotency-Key',value:`{{${key}}}`}],body:{mode:'raw',raw:JSON.stringify(body,null,2),options:{raw:{language:'json'}}},url:`{{base_url}}/api/${path}`},event:[{listen:'prerequest',script:{type:'text/javascript',exec:[`if (!pm.variables.get('${key}')) pm.collectionVariables.set('${key}', pm.variables.replaceIn('{{$guid}}'));`]}},{listen:'test',script:{type:'text/javascript',exec:[`pm.test('Recepción local', () => pm.response.to.have.status(${method==='DELETE'?202:200}));`,"if ([200, 202].includes(pm.response.code)) pm.collectionVariables.set('process_id', pm.response.json().ProcessID);"]}}]});
for(const [name,path] of [['Consultar estado','GetProcessStatus/{{process_id}}'],['Catálogo upgrades','GetUpgrades'],['Últimas solicitudes confirmadas','memberships']])collection.item.push({name,request:{method:'GET',header:[{key:'Authorization',value:'Bearer {{access_token}}'}],url:`{{base_url}}/api/${path}`}});
await mkdir('docs',{recursive:true});
await writeFile('docs/openapi.json',JSON.stringify(spec,null,2)+'\n');
await writeFile('docs/postman_collection.json',JSON.stringify(collection,null,2)+'\n');
for(const env of ['test','prod']){
  const values={base_url:env==='test'?'http://127.0.0.1:3000':'http://127.0.0.1:3001',client_id:'',client_secret:'',scope:'memberships:read memberships:insert memberships:update memberships:upgrade memberships:cancel'};
  await writeFile(`docs/postman_${env}.environment.json`,JSON.stringify({name:`Audax middleware ${env.toUpperCase()}`,values:Object.entries(values).map(([key,value])=>({key,value,enabled:true,type:['client_secret','access_token'].includes(key)?'secret':'default'})),_postman_variable_scope:'environment'},null,2)+'\n');
}
console.log('OpenAPI y colección Postman generados.');
