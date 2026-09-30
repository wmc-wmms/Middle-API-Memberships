import { createAudaxModules } from './audax-modules.js';
const $ = s => document.querySelector(s);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const labels = { queued:'En cola', sending:'Enviando', submitted:'Procesando en Audax', finished:'Finalizado', failed:'Rechazado', unknown:'Requiere conciliación' };
const kinds = { insert:'Alta', update:'Modificación', upgrade:'Upgrade', cancel:'Baja' };
const scopeLabels = { 'memberships:read':'Consultar', 'memberships:insert':'Altas', 'memberships:update':'Modificaciones', 'memberships:upgrade':'Upgrades', 'memberships:cancel':'Bajas', 'memberships:override':'Override (especial)' };
let csrf = sessionStorage.getItem('audax_csrf') || '', config, clients = [], offset = 0, renderVersion = 0, pageTimer=null;
const badge = (state, label) => `<span class="badge ${escape(state)}">${escape(label || labels[state] || state)}</span>`;
const date = value => value ? new Date(value).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' }) : '—';
function toast(message, error = false) { const el=$('#toast'); el.textContent=message; el.className=error?'error':''; el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.hidden=true,5000); }
// Cliente HTTP: incluye sesión y CSRF y expone errores de formulario.
async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token':csrf } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, credentials:'same-origin' });
  const body = await response.json();
  if (!response.ok) {
    if (response.status===401 && path!=='/admin/login') showLogin();
    throw Object.assign(new Error(body.message || 'No se pudo completar la operación'), {details:body.details,status:response.status});
  }
  return body;
}
function showLogin() { clearTimeout(toast.timer);$('#toast').hidden=true; clearTimeout(pageTimer);audaxModules.cancelPage();clearTimeout(detailTimer);document.querySelectorAll('dialog[open]').forEach(d=>d.close()); $('#application').hidden=true; $('#login-screen').hidden=false; sessionStorage.removeItem('audax_csrf'); csrf=''; }
function showApp(session) {
  $('#application').hidden=false; $('#login-screen').hidden=true; $('#admin-name').textContent=session.username;
  $('#sidebar-env').className=`badge ${config.environment}`; $('#sidebar-env').textContent=config.environment==='prod'?'PRODUCCIÓN':'TEST';
  $('#mode-banner').className=`mode-banner ${config.environment}`;
  $('#mode-banner').textContent=config.mode==='mock'?'Ambiente TEST · Simulador local activo. Estas operaciones no se envían a Audax.':`Audax ${config.environment.toUpperCase()} · Consultando estado de conexión.`;
  if(config.use_catalogs)void audaxModules.refreshBanner();
  $('#environment-select').value=config.environment;
  $('#environment-select').onchange=event=>{location.href=config.portal_urls[event.target.value]+'/#overview'};
  void render();
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const form=event.currentTarget, button=form.querySelector('button'); button.disabled=true;
  try { const session=await api('/admin/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))}); csrf=session.csrf_token;sessionStorage.setItem('audax_csrf',csrf);form.reset();$('#login-error').textContent='';showApp(session); }
  catch(e){$('#login-error').textContent=e.message}finally{button.disabled=false}
});
$('#logout-button').onclick=async()=>{try{await api('/admin/logout',{method:'POST'});showLogin()}catch(e){toast(e.message,true)}};
$('#password-button').onclick=()=>{$('#password-form').reset();$('#password-error').textContent='';$('#password-dialog').showModal()};
$('#password-form').onsubmit=async event=>{event.preventDefault();try{await api('/admin/change-password',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});$('#password-dialog').close();showLogin();toast('Contraseña actualizada')}catch(e){$('#password-error').textContent=e.message}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#secret-dialog').addEventListener('close',()=>{$('#generated-secret').value='';$('#generated-id').value=''});
$('#copy-credentials').onclick=async()=>{try{await navigator.clipboard.writeText(JSON.stringify({client_id:$('#generated-id').value,client_secret:$('#generated-secret').value},null,2));toast('Credenciales copiadas')}catch{toast('Seleccioná los campos y copialos manualmente',true)}};
function showSecret(data){$('#generated-id').value=data.client_id;$('#generated-secret').value=data.client_secret;$('#secret-environment').textContent=data.environment.toUpperCase();$('#secret-dialog').showModal()}
function heading(title,subtitle,action=''){return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`}
function empty(title,description,action=''){return `<div class="empty"><div class="empty-icon">◇</div><h3>${title}</h3><p>${description}</p>${action}</div>`}
function operationsTable(rows){return rows.length?`<div class="table-wrap"><table><thead><tr><th>OPERACIÓN / PROCESO</th><th>EMPRESA</th><th>REGISTROS</th><th>ESTADO</th><th>RECIBIDO</th><th></th></tr></thead><tbody>${rows.map(o=>`<tr><td><strong>${kinds[o.kind]}</strong><small class="mono">${escape(o.id.slice(0,18))}…</small></td><td>${escape(o.company_name)}<small>${escape(o.name)}</small></td><td>${o.item_count}</td><td>${badge(o.status)}${o.blocked?'<small>Espera una conciliación anterior</small>':''}</td><td>${date(o.created_at)}</td><td><button data-operation="${o.id}">Ver detalle ↗</button></td></tr>`).join('')}</tbody></table></div>`:empty('Todavía no hay operaciones','Los envíos recibidos por la API aparecerán acá, con su estado y trazabilidad.');}
// Navegación: cancela temporizadores anteriores al cambiar de pantalla.
async function render(){
  if($('#application').hidden)return;
  clearTimeout(pageTimer);audaxModules.cancelPage();
  const version=++renderVersion;const page=location.hash.slice(1)||'overview';
  document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('active',a.dataset.page===page));
  const titles={connection:'Conexión Audax',catalogs:'Catálogos',memberships:'Memberships',overview:'Resumen',clients:'Usuarios API',operations:'Operaciones',guide:'Guía de integración',audit:'Auditoría'};
  $('#breadcrumb').textContent=`Operaciones / ${titles[page]||'Resumen'}`;$('#page-content').innerHTML='<div class="loading">Cargando información…</div>';
  try{
    const custom=await audaxModules.page(page,config);
    if(version!==renderVersion)return;
    if(custom){$('#page-content').innerHTML=custom.html;custom.bind?.();return;}
    let html;
    if(page==='clients'){
      clients=await api('/admin/clients');
      html=heading('Usuarios API','Administrá empresas, permisos y credenciales de integración.','<button class="primary" id="new-client">＋ Nuevo usuario</button>')+
      `<section class="panel"><div class="panel-head"><div><h3>Directorio de usuarios</h3><p>${clients.length} usuarios en este ambiente</p></div><div class="toolbar"><input id="client-search" type="search" placeholder="Buscar usuario o empresa" aria-label="Buscar usuario o empresa"><select id="client-filter" aria-label="Filtrar estado"><option value="all">Todos los estados</option><option value="active">Activos</option><option value="inactive">Inactivos</option></select></div></div><div id="clients-table"></div></section>`;
    }else if(page==='operations'){
      const rows=await api(`/admin/operations?offset=${offset}`);
      html=heading('Operaciones','Recepción, envío y resultado final de cada lote.','<button id="refresh-page">↻ Actualizar</button>')+`<section class="panel">${operationsTable(rows)}<div class="pager"><button id="previous-page" ${offset===0?'disabled':''}>Anterior</button><span>Página ${offset/50+1}</span><button id="next-page" ${rows.length<50?'disabled':''}>Siguiente</button></div></section>`;
    }else if(page==='audit'){
      const rows=await api('/admin/audit');html=heading('Auditoría','Últimos 100 eventos administrativos y de procesamiento.','<button id="refresh-page">↻ Actualizar</button>')+`<section class="panel"><div class="table-wrap"><table><thead><tr><th>FECHA</th><th>ACTOR</th><th>ACCIÓN</th><th>REFERENCIA</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${date(r.created_at)}</td><td>${escape(r.actor)}</td><td>${escape(r.action)}</td><td class="mono">${escape(r.target)}</td></tr>`).join('')}</tbody></table></div></section>`;
    }else if(page==='guide'){
      html=guide();
    }else{
      const [data,rows]=await Promise.all([api('/admin/overview'),api('/admin/operations')]);const count=s=>data.statuses.filter(r=>s.includes(r.status)).reduce((n,r)=>n+r.count,0);
      audaxModules.updateBanner(data.connection);
      const healthy=data.worker_last_seen&&Date.now()-new Date(data.worker_last_seen).valueOf()<120000;
      html=heading('Centro de operaciones','Recibí, controlá y seguí los envíos de tus clientes a Audax.','<button class="primary" id="new-client">＋ Nuevo usuario</button>')+
      `<div class="metrics"><div class="metric"><span class="metric-label">Usuarios activos</span><strong>${data.clients.active}</strong><small>${data.clients.total} usuarios registrados</small></div><div class="metric"><span class="metric-label">Operaciones finalizadas</span><strong>${count(['finished'])}</strong><small>Confirmadas por ${config.mode==='mock'?'el simulador':'Audax'}</small></div><div class="metric"><span class="metric-label">En procesamiento</span><strong>${count(['queued','sending','submitted'])}</strong><small>En cola o pendientes de resultado</small></div><div class="metric"><span class="metric-label">Requieren atención</span><strong>${count(['failed','unknown'])}</strong><small>Rechazos y resultados inciertos</small></div></div>`+
      `<div class="two-columns"><section class="panel"><div class="panel-head"><h3>De tus clientes a Audax</h3>${badge('finished','PERSISTENTE')}</div><div class="panel-body"><div class="step"><span class="step-number">1</span><div><strong>Clientes identificados</strong><p>Cada cliente se autentica con sus propias credenciales y permisos.</p></div></div><div class="step"><span class="step-number">2</span><div><strong>Control del middleware</strong><p>Validamos los datos y permisos y guardamos cada lote antes de enviarlo.</p></div></div><div class="step"><span class="step-number">3</span><div><strong>Envío desde nuestra cuenta</strong><p>Enviamos a Audax con las credenciales corporativas y actualizamos el resultado automáticamente.</p></div></div></div></section><section class="panel"><div class="panel-head"><h3>Estado del ambiente</h3></div><div class="panel-body"><div class="connection-row"><span>Ambiente</span>${badge(config.environment,config.environment.toUpperCase())}</div><div class="connection-row"><span>Procesador</span>${badge(healthy?'finished':'unknown',healthy?'ACTIVO':'SIN SEÑAL')}</div><div class="connection-row"><span>Conexión Audax</span><strong>${config.mode==='mock'?'Simulador local':data.connection?.verified_at?'Verificada':data.connection?.configured?'Pendiente de verificar':'Faltan credenciales'}</strong></div><div class="connection-row"><span>Última señal</span><span>${date(data.worker_last_seen)}</span></div><small>Destino configurado</small><div class="endpoint">${escape(data.audax_url)}</div></div></section></div>`+
      `<section class="panel"><div class="panel-head"><div><h3>Actividad reciente</h3><p>Últimas operaciones recibidas</p></div><a href="#operations">Ver todas →</a></div>${operationsTable(rows.slice(0,6))}</section>`;
    }
    if(version!==renderVersion)return;
    $('#page-content').innerHTML=html;
    if(page==='clients'){renderClients();$('#client-search').oninput=renderClients;$('#client-filter').onchange=renderClients}
    if($('#new-client'))$('#new-client').onclick=()=>openEditor();
    if($('#refresh-page'))$('#refresh-page').onclick=render;
    if($('#previous-page'))$('#previous-page').onclick=()=>{offset=Math.max(0,offset-50);void render()};
    if($('#next-page'))$('#next-page').onclick=()=>{offset+=50;void render()};
    bindDetails();$('#connection-state').textContent='● Servidor activo';
    if(['overview','operations'].includes(page)){const poll=()=>{if(version!==renderVersion)return;if(document.querySelector('dialog[open]'))pageTimer=setTimeout(poll,3000);else void render()};pageTimer=setTimeout(poll,3000);}
  }catch(e){if(version===renderVersion)$('#page-content').innerHTML=empty('No pudimos cargar la información',escape(e.message),'<button id="retry-load">Reintentar</button>');if($('#retry-load'))$('#retry-load').onclick=render;$('#connection-state').textContent='● Revisar conexión'}
}
function renderClients(){
  const query=($('#client-search')?.value||'').toLowerCase(),filter=$('#client-filter')?.value||'all';
  const rows=clients.filter(c=>`${c.name} ${c.company_name} ${c.client_id}`.toLowerCase().includes(query)&&(filter==='all'||c.active===(filter==='active')));
  $('#clients-table').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>USUARIO / EMPRESA</th><th>CLIENT ID</th><th>ACCESO AUDAX</th><th>ESTADO</th><th>ACCIONES</th></tr></thead><tbody>${rows.map(c=>`<tr><td><strong>${escape(c.name)}</strong><small>${escape(c.company_name)}</small></td><td class="mono">${escape(c.client_id.slice(0,24))}…</td><td>${escape(c.business_ids.join(', '))}<small>${c.plan_ids.length} planes · ${c.scopes.length} permisos</small></td><td>${badge(c.active?'finished':'inactive',c.active?'ACTIVO':'INACTIVO')}</td><td><div class="row-actions"><button data-edit="${c.id}">Editar</button><button data-rotate="${c.id}">Nuevo secret</button>${c.active?`<button class="danger" data-disable="${c.id}">Dar de baja</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`:empty(clients.length?'Sin coincidencias':'Creá tu primer usuario API',clients.length?'Probá con otra búsqueda o estado.':'Asignale una empresa, los IDs habilitados y sus permisos de acceso.');
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEditor(clients.find(c=>c.id===b.dataset.edit)));
  document.querySelectorAll('[data-rotate]').forEach(b=>b.onclick=async()=>{if(!confirm('Se invalidarán el secret y los tokens anteriores. ¿Generar nuevas credenciales?'))return;try{showSecret(await api(`/admin/clients/${b.dataset.rotate}/rotate-secret`,{method:'POST'}))}catch(e){toast(e.message,true)}});
  document.querySelectorAll('[data-disable]').forEach(b=>b.onclick=async()=>{if(!confirm('¿Dar de baja este usuario API? Se revoca su acceso y se conserva el historial. Los envíos ya iniciados pueden terminar en Audax.'))return;try{await api(`/admin/clients/${b.dataset.disable}`,{method:'DELETE'});toast('Usuario dado de baja');await render()}catch(e){toast(e.message,true)}});
}
// ABM: asigna pares business/plan; no entrega credenciales oficiales.
async function openEditor(client){
  const form=$('#client-form');form.reset();$('#client-error').textContent='';$('#editor-title').textContent=client?'Editar usuario API':'Nuevo usuario API';
  for(const key of ['id','name','company_name','email'])form.elements[key].value=client?.[key]||'';
  for(const key of ['business_ids','plan_ids'])form.elements[key].value=(client?.[key]||[]).join(', ');
  form.elements.active.checked=client?.active??true;
  $('#scope-options').innerHTML=Object.entries(scopeLabels).map(([scope,label])=>`<label class="check"><input type="checkbox" name="scopes" value="${scope}" ${(client?client.scopes.includes(scope):scope!=='memberships:override')?'checked':''}>${label}</label>`).join('');
  $('#legacy-permissions').hidden=!!config.use_catalogs;
  for(const key of ['business_ids','plan_ids']){form.elements[key].disabled=!!config.use_catalogs;form.elements[key].required=!config.use_catalogs;}
  $('#real-permissions').hidden=!config.use_catalogs;
  try{if(config.use_catalogs)await audaxModules.clientEditor(client);$('#editor-dialog').showModal();}catch(e){toast(e.message,true)}
}
$('#client-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,values=new FormData(form),id=values.get('id'),button=form.querySelector('[type=submit]');button.disabled=true;
  const body={name:values.get('name'),company_name:values.get('company_name'),email:values.get('email'),business_ids:(values.get('business_ids')||'').split(',').map(s=>s.trim()).filter(Boolean),plan_ids:(values.get('plan_ids')||'').split(',').map(s=>s.trim()).filter(Boolean),scopes:values.getAll('scopes'),active:values.has('active')};
  try{if(config.use_catalogs)Object.assign(body,audaxModules.clientPermissions());const result=await api(id?`/admin/clients/${id}`:'/admin/clients',{method:id?'PUT':'POST',body:JSON.stringify(body)});$('#editor-dialog').close();if(result.client_secret)showSecret(result);toast(id?'Usuario actualizado; tokens anteriores revocados':'Usuario creado');await render()}
  catch(e){$('#client-error').textContent=e.message}finally{button.disabled=false}
};
function bindDetails(){document.querySelectorAll('[data-operation]').forEach(b=>b.onclick=()=>operationDetail(b.dataset.operation))}
let detailTimer=null,detailGeneration=0;
$('#detail-dialog').addEventListener('close',()=>{clearTimeout(detailTimer);detailGeneration++});
// Actualiza el resultado hasta que finaliza el proceso o se cierra el diálogo.
async function operationDetail(id){const generation=++detailGeneration;clearTimeout(detailTimer);try{
  const data=await api(`/admin/operations/${id}`);if(generation!==detailGeneration)return;
  $('#operation-detail').innerHTML=`<div class="detail-kv"><span>Operación</span><span>${kinds[data.operation]}</span><span>Estado</span><span>${badge(data.middleware_status)}</span><span>Origen</span><span>${data.source==='manual'?'Carga manual · '+escape(data.created_by||'admin'):'API del cliente'}</span><span>Proceso middleware</span><span class="mono">${escape(data.id)}</span><span>Proceso Audax</span><span class="mono">${escape(data.audax_process_id||'Todavía no informado')}</span><span>Recibido</span><span>${date(data.created_at)}</span></div><h3>Registros</h3>${data.items.map(i=>`<div class="detail-item">${escape(i.membership_number)} · ${escape(i.status)}${i.errors?`<pre>${escape(JSON.stringify(i.errors,null,2))}</pre>`:''}</div>`).join('')}${data.errors?`<h3>Resultado / error</h3><pre>${escape(JSON.stringify(data.errors,null,2))}</pre>`:''}<h3>Últimos intentos</h3><pre>${escape(JSON.stringify(data.attempts,null,2))}</pre>${data.middleware_status==='unknown'&&data.operation!=='cancel'?`<form id="reconcile-form"><div class="note">Ingresá solo el ProcessID que Audax o su soporte confirme que corresponde exactamente a este lote. La consulta de estado no permite verificar por sí sola esa asociación. Esta acción no reenvía datos.</div><label>ProcessID de Audax<input name="audax_process_id" required value="${escape(data.audax_process_id||'')}"></label><button class="primary">Reanudar seguimiento</button></form>`:''}`;
  if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
  if(['queued','sending','submitted'].includes(data.middleware_status))detailTimer=setTimeout(()=>{if(generation===detailGeneration&&$('#detail-dialog').open)void operationDetail(id)},3000);
  if($('#reconcile-form'))$('#reconcile-form').onsubmit=async event=>{event.preventDefault();try{await api(`/admin/operations/${id}/reconcile`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});toast('Seguimiento reanudado');await operationDetail(id);await render()}catch(e){toast(e.message,true)}};
}catch(e){toast(e.message,true)}}
// Contrato de integración: URL del ambiente, scopes y descargas autenticadas.
function guide(){
  const origin=location.origin;
  const sample=[{plan_id:'999',membership_number:'MEM-001',national_id:'AB123456',business_id:'111',last_name:'Doe',first_name:'John',issued_country:'14',date_of_birth:'1980-05-15',issued_date:'2027-01-01',valid_from:'2027-02-01',valid_to:'2027-03-01',max_consecutive_days_per_trip:30,price:10,currency_id:'157'}];
  const integrationScope='memberships:read memberships:insert memberships:update memberships:upgrade memberships:cancel';
  return heading('Guía de integración','Integrá a tus clientes con WMC + WMMS. El middleware gestiona el envío a Audax.')+`<section class="panel"><div class="panel-head"><h3>URLs y scope · ${escape(config.environment.toUpperCase())}</h3></div><div class="panel-body"><p>Base del middleware: <code>${escape(origin)}</code></p><p>Token: <code>${escape(origin)}/oauth/token</code></p><p>Alta: <code>${escape(origin)}/api/InsertMembershipBatch</code></p><p>Scope para las cinco operaciones, si están habilitadas en el usuario:</p><pre>${integrationScope}</pre><p>Usá el client ID y secret generados en Usuarios API. El scope de Audax/Portsoft es distinto y se configura únicamente en Conexión Audax. Para permisos limitados, pedí solo los scopes asignados al usuario.</p><div class="toolbar"><a class="button" href="/admin/downloads/postman_collection.json" download>Descargar colección Postman</a><a href="/admin/downloads/postman_test.environment.json" download>Ambiente TEST</a><a href="/admin/downloads/postman_prod.environment.json" download>Ambiente PROD</a><a href="/admin/downloads/openapi.json" download>OpenAPI</a></div><p>Importá la colección JSON. En sus variables completá client_id y client_secret; la URL del entorno y el scope ya están definidos. Ejecutá Obtener token y luego Insert. Reutilizá la clave de idempotencia para reintentos; vaciala para iniciar otra operación. Los ejemplos de membership deben ajustarse a los IDs habilitados y al titular.</p></div></section><div class="guide-grid"><section class="panel"><div class="panel-head"><h3>01 · Obtener un token</h3></div><div class="panel-body"><p>Usá las credenciales del usuario API de este ambiente.</p><pre>${escape(`POST ${origin}/oauth/token\nContent-Type: application/x-www-form-urlencoded\n\ngrant_type=client_credentials\nclient_id=TU_CLIENT_ID\nclient_secret=TU_CLIENT_SECRET\nscope=memberships:insert memberships:read`)}</pre><small>También se admite autenticación HTTP Basic. El token vence en una hora.</small></div></section><section class="panel"><div class="panel-head"><h3>02 · Enviar una operación</h3></div><div class="panel-body"><pre>${escape(`POST ${origin}/api/InsertMembershipBatch\nAuthorization: Bearer TU_TOKEN\nIdempotency-Key: envio-unico-0001\nContent-Type: application/json\n\n${JSON.stringify(sample,null,2)}`)}</pre></div></section><section class="panel"><div class="panel-head"><h3>03 · Consultar el resultado</h3></div><div class="panel-body"><p>La respuesta de recepción incluye un ProcessID local. Consultá hasta obtener un estado final.</p><pre>${escape('GET /api/GetProcessStatus/{ProcessID}\nAuthorization: Bearer TU_TOKEN\n\n{ "id": "...", "status": "finished" }')}</pre><p>Estados: <code>processing</code>, <code>finished</code>, <code>failed</code> y <code>unknown</code>. Un lote rechazado no aplica cambios parciales.</p><div class="note">Si repetís un envío, mantené la misma Idempotency-Key. Con contenido distinto, el middleware devuelve 409.</div></div></section><section class="panel"><div class="panel-head"><h3>04 · Modificaciones, upgrades y bajas</h3></div><div class="panel-body"><p><strong>Update:</strong> POST /api/UpdateMembershipBatch, con el objeto completo.</p><div class="note">Update no modifica el precio oficial. Audax usa PriceMemberships para esa operación, que no se ejecuta automáticamente.</div><p><strong>Upgrade:</strong> POST /api/UpgradeMembershipBatch, con el objeto completo y el campo:</p><pre>${escape(JSON.stringify({upgrades:[{'22':{valid_from:'2027-02-05',valid_to:'2027-02-15',price:11,currency_id:'157'}}]},null,2))}</pre><p>Requiere permisos de upgrade y update. El middleware lo remite a UpdateMembershipBatch. Consultá el catálogo en GET /api/GetUpgrades.</p><p><strong>Baja:</strong> DELETE /api/CancelMembership</p><pre>${escape(JSON.stringify({business_id:'111',plan_id:'999',issued_country:'14',membership_number:'MEM-001'},null,2))}</pre><small>La baja devuelve 202 + ProcessID local. Audax permite modificar o cancelar solo antes de la vigencia y si no existen casos asociados.</small></div></section></div>`;
}
const audaxModules=createAudaxModules({api,escape,toast,heading,empty,badge,date,refresh:render,openOperation:operationDetail,getConfig:()=>config});
window.addEventListener('hashchange',()=>{offset=0;void render()});
try{config=await api('/public/config');$('#login-environment').textContent=config.environment==='prod'?'PRODUCCIÓN':'AMBIENTE TEST';$('#login-environment').className=`badge ${config.environment}`;if(csrf)showApp(await api('/admin/session'))}catch(e){showLogin();if(!config)$('#login-error').textContent='No se pudo conectar al servidor. Recargá la página.'}
