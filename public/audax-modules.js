export function createAudaxModules({api,escape:e,toast:rawToast,heading,empty,badge,date,refresh,openOperation,getConfig}) {
  const $=s=>document.querySelector(s);
  const environment=()=>getConfig().environment.toUpperCase();
  const toast=(message,error)=>rawToast(message.replaceAll('TEST',environment()),error);
  const names={business:'Empresas',plans:'Planes',countries:'Países',currencies:'Monedas',locations:'Grupos de ubicación',conditions:'Condiciones',upgrades:'Upgrades'};
  let timer=null,epoch=0,selectedPairs=[],snapshot=null,memberRows=[],memberClients=[],manualKey='',prepared=null;
  const errorText=error=>error.details?.length?`${error.message}\n${error.details.map(d=>`${d.path?.join('.')||'Datos'}: ${d.message}`).join('\n')}`:error.message;
  const options=(rows,selected='',placeholder='Seleccionar…')=>`<option value="">${placeholder}</option>${rows.map(r=>`<option value="${e(r.id)}" ${String(selected)===r.id?'selected':''}>${e(r.name)} · ${e(r.id)}</option>`).join('')}`;
// Un temporizador por página. epoch descarta respuestas de pantallas abandonadas.
  function cancelPage(){epoch++;clearTimeout(timer);}
  function updateBanner(status){
    if(!status)return;
    if(status.local_preview){$('#mode-banner').textContent='PROD · Base independiente y vacía. Vista local sin envíos; pendiente habilitar PostgreSQL, HTTPS y credenciales de producción.';return;}
    const state=$('#connection-badge');if(state){state.className=`badge ${status.verified_at?'finished':'queued'}`;state.textContent=status.verified_at?'VERIFICADA':'PENDIENTE';}
    $('#mode-banner').textContent=!status.configured?`Audax ${environment()} real · Falta configurar las credenciales en Conexión Audax.`:status.last_error?`Audax ${environment()} real · Revisá la conexión: ${status.last_error}`:status.verified_at?`Audax ${environment()} real · Última conexión verificada: ${date(status.verified_at)}. Los envíos se realizan a ${environment()}.`:`Audax ${environment()} real · Credenciales guardadas. Falta probar la conexión.`;
  }
  async function refreshBanner(){try{updateBanner(await api('/admin/audax/settings'))}catch{/* API helper handles an expired admin session. */}}
  function syncSummary(s){
    const run=s.last_run;
    if(!run)return '<div class="catalog-status">Todavía no se sincronizaron catálogos desde Audax TEST.</div>';
    const text={queued:'Sincronización en cola',running:'Consultando catálogos en Audax TEST…',finished:'Catálogos actualizados',failed:'No se pudo completar la sincronización'}[run.status];
    return `<div class="catalog-status ${run.status==='failed'?'has-error':''}"><strong>${text}</strong><span>${e(run.error||'')}</span>${(run.warnings||[]).map(w=>`<span>${e(w)}</span>`).join('')}<small>Última sincronización completa: ${date(s.last_success_at)}</small></div>`;
  }
  function followSync(onDone){
    const version=epoch;
    const poll=async()=>{
      try{
        const snap=await api('/admin/catalogs');if(version!==epoch)return;
        if($('#sync-status'))$('#sync-status').innerHTML=syncSummary(snap);
        if(['queued','running'].includes(snap.last_run?.status))timer=setTimeout(poll,2000);
        else{await refreshBanner();if(onDone)onDone(snap);}
      }catch(err){if(version===epoch)toast(err.message,true)}
    };void poll();
  }
// Configura las credenciales del ambiente. El secret nunca se vuelve a mostrar.
  async function connectionPage(){
    const [s,snap]=await Promise.all([api('/admin/audax/settings'),api('/admin/catalogs')]);updateBanner(s);
    const html=heading('Conexión Audax','Configurá el acceso oficial al entorno TEST. Las credenciales de tus clientes se administran por separado.',badge('test','AUDAX TEST'))+
    `<div class="connection-grid"><section class="panel"><div class="panel-head"><div><h3>Credenciales oficiales</h3><p>Datos provistos por Portsoft para Audax TEST.</p></div><span id="connection-badge" class="badge ${s.verified_at?'finished':'queued'}">${s.verified_at?'VERIFICADA':'PENDIENTE'}</span></div><div class="panel-body"><form id="audax-settings-form"><input type="hidden" name="revision" value="${s.revision}"><label>Client ID de Audax TEST<input name="client_id" required maxlength="200" autocomplete="off" value="${e(s.client_id)}"></label><label>Client secret de Audax TEST<input name="client_secret" type="password" maxlength="8192" autocomplete="new-password" ${s.secret_configured?'':'required'} placeholder="${s.secret_configured?'Secret guardado · dejá vacío para conservarlo':'Ingresá el secret de Portsoft'}"><small>Se almacena cifrado y no se vuelve a mostrar.</small></label><label>Scope de Audax TEST<input name="scope" required maxlength="1500" autocomplete="off" value="${e(s.scope)}" placeholder="Scope provisto por Portsoft"><small>Es el scope de Audax, no los permisos memberships:* de tus usuarios.</small></label><p id="audax-settings-error" class="form-error" role="alert"></p><div class="connection-actions"><button class="primary" type="submit">Guardar, conectar y sincronizar</button><button id="test-audax" type="button" ${s.configured?'':'disabled'}>Probar conexión guardada</button></div></form></div></section><div><section class="panel"><div class="panel-head"><h3>Destino de las solicitudes</h3></div><div class="panel-body"><span class="badge">TEST · API OFICIAL</span><label>Base URL<div class="endpoint">${e(s.base_url)}</div></label><label>Autenticación<div class="endpoint">${e(s.token_url)}</div></label><div class="connection-row"><span>Última verificación</span><span id="connection-verified">${date(s.verified_at)}</span></div><p class="small-copy">El ambiente y las URLs están fijados por el servidor. Cada entorno usa exclusivamente su URL y su base independiente.</p></div></section><section class="panel"><div class="panel-head"><h3>Sincronización local</h3><a href="#catalogs">Ver catálogos →</a></div><div class="panel-body"><div id="sync-status">${syncSummary(snap)}</div><p class="small-copy">Empresas, planes, países, monedas, ubicaciones y condiciones quedan disponibles en la base local para los formularios.</p></div></section></div></div>`;
    return {html,bind(){
      const form=$('#audax-settings-form');
      if(s.local_preview){for(const input of form.querySelectorAll('input,button'))input.disabled=true;$('#audax-settings-error').textContent='PROD local es una vista vacía. Se habilita en un despliegue con PostgreSQL y HTTPS.';}
      form.onsubmit=async event=>{
        event.preventDefault();const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);$('#audax-settings-error').textContent='';
        try{
          const data=Object.fromEntries(new FormData(form));data.revision=Number(data.revision);
          const saved=await api('/admin/audax/settings',{method:'PUT',body:JSON.stringify(data)});
          form.elements.revision.value=saved.revision;form.elements.client_secret.value='';form.elements.client_secret.required=false;form.elements.client_secret.placeholder='Secret guardado · dejá vacío para conservarlo';
          updateBanner(saved);
          const checked=await api('/admin/audax/test',{method:'POST'});updateBanner(checked);$('#connection-verified').textContent=date(checked.verified_at);
          await api('/admin/catalogs/sync',{method:'POST'});toast('Conexión verificada. Sincronizando catálogos…');followSync();
        }catch(err){$('#audax-settings-error').textContent=errorText(err);await refreshBanner()}
        finally{buttons.forEach(b=>b.disabled=false)}
      };
      $('#test-audax').onclick=async event=>{event.currentTarget.disabled=true;$('#audax-settings-error').textContent='';try{const checked=await api('/admin/audax/test',{method:'POST'});updateBanner(checked);$('#connection-verified').textContent=date(checked.verified_at);toast(`Conexión verificada: ${checked.business_count} empresas accesibles`)}catch(err){$('#audax-settings-error').textContent=errorText(err);await refreshBanner()}finally{if($('#test-audax'))$('#test-audax').disabled=false}};
      if(['queued','running'].includes(snap.last_run?.status))followSync();
    }};
  }
// Consulta local de relaciones oficiales, sin asociaciones manuales.
  async function catalogsPage(){
    snapshot=await api('/admin/catalogs');const snap=snapshot;
    const html=heading('Catálogos de Audax TEST','Datos importados de la API oficial y almacenados en tu base local.','<button class="primary" id="sync-catalogs">↻ Sincronizar catálogos</button>')+
    `<div id="sync-status">${syncSummary(snap)}</div><div class="catalog-metrics">${Object.keys(names).map(k=>`<button type="button" class="catalog-metric" data-catalog="${k}"><span>${names[k]}</span><strong>${snap.catalogs[k].length}</strong><small>${k==='upgrades'?'Opcional · GetUpgrades':'Importados de Audax'}</small></button>`).join('')}</div>`+
    `<section class="panel"><div class="panel-head"><h3>Planes por empresa</h3><span class="badge">IMPORTADOS DE AUDAX</span></div><div class="panel-body"><p>La clave de cada grupo de GetPlans identifica al business de GetBusiness. La sincronización guarda esa relación automáticamente.</p><label>Empresa<select id="catalog-business">${options(snap.catalogs.business)}</select></label><div id="business-plan-options"><p>Seleccioná una empresa para consultar sus planes.</p></div></div></section>`+
    `<section class="panel"><div class="panel-head"><h3 id="catalog-title">Empresas</h3><input type="search" id="catalog-search" class="catalog-search" placeholder="Buscar por nombre o ID" aria-label="Buscar catálogo"></div><div id="catalog-table"></div></section>`;
    return {html,bind(){
      let selected='business';
      function renderTable(){
        const q=$('#catalog-search').value.trim().toLowerCase(),rows=snap.catalogs[selected].filter(r=>`${r.id} ${r.name} ${r.data.iso3166||r.data.iso4217||''}`.toLowerCase().includes(q));
        $('#catalog-title').textContent=names[selected];document.querySelectorAll('[data-catalog]').forEach(b=>b.classList.toggle('selected',b.dataset.catalog===selected));
        $('#catalog-table').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>ID OFICIAL</th><th>NOMBRE</th><th>DETALLE</th><th>SINCRONIZADO</th></tr></thead><tbody>${rows.slice(0,500).map(r=>`<tr><td class="mono">${e(r.id)}</td><td>${e(r.name)}</td><td>${e(r.data.iso3166||r.data.iso4217||r.data.business_id||r.data.business_ids?.join(', ')||'—')}</td><td>${date(r.synced_at)}</td></tr>`).join('')}</tbody></table></div>${rows.length>500?'<p class="table-hint">Mostrando 500 coincidencias. Usá la búsqueda para encontrar un registro.</p>':''}`:empty('Sin registros',snap.last_success_at?'No hay coincidencias en este catálogo.':'Configurá la conexión y sincronizá los datos de Audax TEST.');
      }
      document.querySelectorAll('[data-catalog]').forEach(b=>b.onclick=()=>{selected=b.dataset.catalog;renderTable()});$('#catalog-search').oninput=renderTable;renderTable();
      $('#sync-catalogs').onclick=async event=>{event.currentTarget.disabled=true;try{await api('/admin/catalogs/sync',{method:'POST'});followSync(()=>void refresh())}catch(err){toast(err.message,true);if($('#sync-catalogs'))$('#sync-catalogs').disabled=false}};
      $('#catalog-business').onchange=()=>{
        const business=$('#catalog-business').value,ids=snap.business_plans.filter(l=>l.business_id===business).map(l=>l.plan_id);
        const plans=snap.catalogs.plans.filter(p=>ids.includes(p.id));
        $('#business-plan-options').innerHTML=plans.length?`<div class="catalog-checkboxes">${plans.map(p=>`<div>${e(p.name)} <small>· ${e(p.id)}</small></div>`).join('')}</div>`:'<p>Audax no informó planes para esta empresa.</p>';
      };
      if(['queued','running'].includes(snap.last_run?.status)){$('#sync-catalogs').disabled=true;followSync(()=>void refresh())}
    }};
  }
// Selección dependiente de empresas y sus planes según GetPlans.
  async function clientEditor(client){
    snapshot=await api('/admin/catalogs');selectedPairs=[...(client?.business_plan_pairs||[])];
    const form=$('#client-form'),selectedBusiness=new Set(client?.business_ids||[]);
    $('#real-permissions').innerHTML=`<label>Empresas de Audax ${environment()}<select id="client-businesses" multiple size="4">${snapshot.catalogs.business.map(b=>`<option value="${e(b.id)}" ${selectedBusiness.has(b.id)?'selected':''}>${e(b.name)} · ${e(b.id)}</option>`).join('')}</select><small>Podés seleccionar más de una empresa. Los planes se asignan por business.</small></label><div id="client-real-plans"></div>${!snapshot.catalogs.business.length?'<div class="note">No hay empresas sincronizadas. Abrí Conexión Audax y sincronizá los catálogos.</div>':''}`;
    const businesses=$('#client-businesses');
    function draw(){
      const selected=[...businesses.selectedOptions].map(o=>o.value);
      selectedPairs=selectedPairs.filter(p=>selected.includes(p.business_id));
      $('#client-real-plans').innerHTML=selected.map(id=>{
        const business=snapshot.catalogs.business.find(b=>b.id===id),links=snapshot.business_plans.filter(l=>l.business_id===id);
        return `<fieldset><legend>${e(business.name)}</legend>${links.length?links.map(l=>{const plan=snapshot.catalogs.plans.find(p=>p.id===l.plan_id);return `<label class="check"><input type="checkbox" data-business="${e(id)}" data-plan="${e(l.plan_id)}" ${selectedPairs.some(p=>p.business_id===id&&p.plan_id===l.plan_id)?'checked':''}><span>${e(plan.name)} <small>· ${e(l.plan_id)}</small></span></label>`}).join(''):'<p>Audax no informó planes para esta empresa. Actualizá los catálogos.</p>'}</fieldset>`;
      }).join('')||'<p class="small-copy">Seleccioná una empresa para elegir sus planes.</p>';
      document.querySelectorAll('#client-real-plans [data-plan]').forEach(box=>box.onchange=()=>{selectedPairs=[...document.querySelectorAll('#client-real-plans [data-plan]:checked')].map(el=>({business_id:el.dataset.business,plan_id:el.dataset.plan}))});
      if(!form.elements.company_name.value||form.elements.company_name.dataset.auto==='true'){
        form.elements.company_name.value=selected.map(id=>snapshot.catalogs.business.find(b=>b.id===id).name).join(' / ');form.elements.company_name.dataset.auto='true';
      }
    }
    form.elements.company_name.dataset.auto=client?'false':'true';form.elements.company_name.oninput=()=>form.elements.company_name.dataset.auto='false';businesses.onchange=draw;draw();
  }
  function clientPermissions(){
    const pairs=[...document.querySelectorAll('#client-real-plans [data-plan]:checked')].map(el=>({business_id:el.dataset.business,plan_id:el.dataset.plan}));
    if(!pairs.length)throw new Error('Seleccioná al menos una combinación de empresa y plan real.');
    const selected=[...$('#client-businesses').selectedOptions].map(o=>o.value);
    if(selected.some(id=>!pairs.some(p=>p.business_id===id)))throw new Error('Cada empresa seleccionada debe tener al menos un plan habilitado.');
    return {business_plan_pairs:pairs,business_ids:[...new Set(pairs.map(p=>p.business_id))],plan_ids:[...new Set(pairs.map(p=>p.plan_id))]};
  }
// Refresco de estados; nunca vuelve a enviar la membership.
  async function membershipsPage(){
    const [rows,clients,snap,s,activity]=await Promise.all([api('/admin/memberships'),api('/admin/clients'),api('/admin/catalogs'),api('/admin/audax/settings'),api('/admin/membership-activity')]);
    memberRows=rows;memberClients=clients;snapshot=snap;
    const ready=s.verified_at&&snap.last_success_at&&clients.some(c=>c.active&&c.business_plan_pairs?.length);
    const html=heading('Memberships','Cargá o actualizá una membership desde el panel y seguí su envío a Audax TEST.',`<div class="toolbar"><button id="manual-update" ${ready?'':'disabled'}>Actualizar existente</button><button class="primary" id="manual-insert" ${ready?'':'disabled'}>＋ Alta manual</button></div>`)+
    `${!ready?'<div class="note onboarding-note">Para cargar memberships, verificá la <a href="#connection">conexión a Audax</a>, sincronizá los <a href="#catalogs">catálogos</a> y creá un <a href="#clients">usuario API</a> con business y planes asignados.</div>':''}`+
    `<section class="panel"><div class="panel-head"><div><h3>Memberships confirmadas</h3><p>Registros procesados por este middleware. Para actualizar otra membership de Audax, usá «Actualizar existente» e ingresá sus datos completos.</p></div><div class="toolbar"><input id="membership-search" type="search" placeholder="Número, nombre o empresa" aria-label="Buscar memberships"><button id="membership-refresh">↻ Actualizar</button></div></div><div id="membership-table"></div><div class="pager"><button id="membership-prev" disabled>Anterior</button><span id="membership-page">Página 1</span><button id="membership-next">Siguiente</button></div></section>`;
    return {html:html+`<section class="panel"><div class="panel-head"><div><h3>Resultado de los envíos</h3><p>Seguimiento automático cada 3 segundos. Audax informa la aceptación o los errores del lote.</p></div></div><div id="membership-activity"></div></section>`,bind(){
      let offset=0,searchTimer,requestId=0;const pageEpoch=epoch;
      function table(){
        $('#membership-table').innerHTML=memberRows.length?`<div class="table-wrap"><table><thead><tr><th>MEMBERSHIP</th><th>TITULAR</th><th>EMPRESA / PLAN</th><th>VIGENCIA</th><th>ESTADO</th><th></th></tr></thead><tbody>${memberRows.map((r,i)=>`<tr><td><strong>${e(r.payload.membership_number)}</strong><small>${e(r.client_name)}</small></td><td>${e(r.payload.last_name||'')} ${e(r.payload.first_name||'')}</td><td>${e(r.company_name)}<small>${e(snapshot.catalogs.plans.find(p=>p.id===r.payload.plan_id)?.name||r.payload.plan_id)}</small></td><td>${e(r.payload.valid_from||'—')}<small>hasta ${e(r.payload.valid_to||'—')}</small></td><td>${badge(r.status==='active'?'finished':'inactive',r.status==='active'?'CONFIRMADA':'CANCELADA')}</td><td><button data-member-edit="${i}" ${ready?'':'disabled'}>Actualizar</button></td></tr>`).join('')}</tbody></table></div>`:empty('Sin memberships confirmadas','Las altas y modificaciones aparecerán acá cuando Audax confirme el proceso. Podés seguir los envíos pendientes en Operaciones.');
        $('#membership-prev').disabled=offset===0;$('#membership-next').disabled=memberRows.length<50;$('#membership-page').textContent=`Página ${offset/50+1}`;
        document.querySelectorAll('[data-member-edit]').forEach(b=>b.onclick=()=>void openManual('update',memberRows[Number(b.dataset.memberEdit)]));
      }
      function activityTable(items){
        $('#membership-activity').innerHTML=items.length?`<div class="table-wrap"><table><thead><tr><th>MEMBERSHIP</th><th>OPERACIÓN</th><th>ESTADO</th><th>PROCESS ID AUDAX / ERROR</th></tr></thead><tbody>${items.map(i=>`<tr><td>${e(i.membership_number)}<small>${e(i.company_name)}</small></td><td>${e({insert:'Alta',update:'Modificación',upgrade:'Upgrade',cancel:'Baja'}[i.kind])}</td><td>${badge(i.status)}</td><td><small class="mono">${e(i.audax_process_id||'Pendiente de recepción en Audax')}</small>${i.error?`<pre>${e(JSON.stringify(i.error,null,2))}</pre>`:''}<button data-activity-id="${e(i.id)}">Ver detalle</button></td></tr>`).join('')}</tbody></table></div>`:empty('Todavía no hay envíos','Al guardar una membership, su resultado aparecerá automáticamente acá.');
        document.querySelectorAll('[data-activity-id]').forEach(b=>b.onclick=()=>openOperation(b.dataset.activityId));
      }
      async function load(){const version=++requestId;try{const search=encodeURIComponent($('#membership-search').value);const [rows,activity]=await Promise.all([api(`/admin/memberships?offset=${offset}&search=${search}`),api(`/admin/membership-activity?search=${search}`)]);if(version!==requestId||pageEpoch!==epoch||!$('#membership-table'))return;memberRows=rows;table();activityTable(activity)}catch(err){if(pageEpoch===epoch)toast(err.message,true)}}
      async function poll(){if(pageEpoch!==epoch)return;await load();if(pageEpoch===epoch)timer=setTimeout(poll,3000)}
      activityTable(activity);timer=setTimeout(poll,3000);
      $('#manual-insert').onclick=()=>void openManual('insert');$('#manual-update').onclick=()=>void openManual('update');$('#membership-refresh').onclick=load;
      $('#membership-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{offset=0;void load()},300)};
      $('#membership-prev').onclick=()=>{offset=Math.max(0,offset-50);void load()};$('#membership-next').onclick=()=>{offset+=50;void load()};table();
    }};
  }
// Precarga datos y permisos; el servidor comparte validaciones con la API.
  async function openManual(kind,record){
    try{
      const [clients,snap]=await Promise.all([api('/admin/clients'),api('/admin/catalogs')]);memberClients=clients;snapshot=snap;
      const form=$('#manual-membership-form');form.reset();manualKey=crypto.randomUUID();prepared=null;
      $('#manual-error').textContent='';
      const fields=record?.payload||{};form.elements.kind.value=kind;
      $('#manual-title').textContent=kind==='insert'?'Alta manual de membership':'Actualizar membership';
      $('#manual-price-note').hidden=kind==='insert';
      const eligible=clients.filter(c=>c.active&&c.scopes.includes(`memberships:${kind}`)&&c.business_plan_pairs?.length);
      form.elements.client_id.innerHTML=options(eligible.map(c=>({id:c.id,name:`${c.name} · ${c.company_name}`})),record?.client_id||'','Seleccionar usuario API');
      form.elements.issued_country.innerHTML=options(snap.catalogs.countries,fields.issued_country||'');form.elements.currency_id.innerHTML=options(snap.catalogs.currencies,String(fields.currency_id??''),'Sin informar');
      for(const key of ['membership_number','national_id','last_name','first_name','date_of_birth','issued_date','valid_from','valid_to','max_consecutive_days_per_trip','price'])form.elements[key].value=fields[key]??'';
      form.elements.upgrades.value=fields.upgrades?JSON.stringify(fields.upgrades,null,2):'';
      form.elements.override.checked=false;
      function plans(selected=''){
        const client=eligible.find(c=>c.id===form.elements.client_id.value),business=form.elements.business_id.value;
        const ids=client?.business_plan_pairs.filter(p=>p.business_id===business).map(p=>p.plan_id)||[];
        const allowed=snapshot.business_plans.filter(l=>l.business_id===business&&ids.includes(l.plan_id)).map(l=>l.plan_id);
        form.elements.plan_id.innerHTML=options(snapshot.catalogs.plans.filter(p=>allowed.includes(p.id)),selected);
        $('#manual-upgrade-help').textContent=snapshot.catalogs.upgrades.filter(u=>u.data.business_id===business).map(u=>`${u.data.upgrade_id}: ${u.name}`).join(' · ')||'Sin upgrades sincronizados para esta empresa.';
      }
      function businesses(selected=''){
        const client=eligible.find(c=>c.id===form.elements.client_id.value),ids=client?.business_ids||[];
        form.elements.business_id.innerHTML=options(snapshot.catalogs.business.filter(b=>ids.includes(b.id)),selected);
        if(!selected&&ids.length===1)form.elements.business_id.value=ids[0];plans(fields.plan_id||'');
      }
      if(!record&&eligible.length===1)form.elements.client_id.value=eligible[0].id;
      form.elements.client_id.onchange=()=>businesses();form.elements.business_id.onchange=()=>plans();businesses(fields.business_id||'');
      form.oninput=()=>{prepared=null};form.onchange=()=>{prepared=null};
      form.querySelector('[type=submit]').textContent=`Guardar y enviar a Audax ${environment()}`;
      $('#manual-dialog .eyebrow').textContent=`ENVÍO A AUDAX ${environment()}`;
      $('#manual-dialog').showModal();
    }catch(err){toast(err.message,true)}
  }
// Un clic encola; idempotencia conserva la clave cuando se pierde una respuesta.
  function setupManual(){
    const form=$('#manual-membership-form');
    form.onsubmit=async event=>{
      event.preventDefault();$('#manual-error').textContent='';const button=form.querySelector('[type=submit]');button.disabled=true;
      try{
        const values=Object.fromEntries(new FormData(form));
        const membership=Object.fromEntries(['business_id','plan_id','issued_country','membership_number','national_id','last_name','first_name','date_of_birth','issued_date','valid_from','valid_to'].map(k=>[k,values[k]]));
        membership.max_consecutive_days_per_trip=Number(values.max_consecutive_days_per_trip);
        if(values.price!=='')membership.price=Number(values.price);
        if(values.currency_id!=='')membership.currency_id=values.currency_id;
        if(values.upgrades.trim())membership.upgrades=JSON.parse(values.upgrades);
        if(values.override==='on')membership.override=true;
        prepared={client_id:values.client_id,kind:values.kind,membership};
        // One action persists the request; background polling handles the final Audax result.
        const result=await api('/admin/memberships/manual',{method:'POST',headers:{'Idempotency-Key':manualKey},body:JSON.stringify(prepared)});
        $('#manual-dialog').close();toast('Membership recibida. El resultado se actualizará automáticamente.');await refresh();
      }catch(err){$('#manual-error').textContent=err instanceof SyntaxError?'El JSON de upgrades no es válido.':errorText(err)}finally{button.disabled=false}
    };
    $('#manual-dialog').addEventListener('close',()=>{form.reset();prepared=null});
  }
  setupManual();
  async function page(name,config){
    if(!['connection','catalogs','memberships'].includes(name))return null;
    if(!config.use_catalogs)return {html:empty('Módulo de Audax TEST','Este módulo está disponible al ejecutar el servidor en TEST con conexión real.'),bind(){}};
    const result=await(name==='connection'?connectionPage():name==='catalogs'?catalogsPage():membershipsPage());
    result.html=result.html.replaceAll('TEST',environment());return result;
  }
  return {page,cancelPage,clientEditor,clientPermissions,refreshBanner,updateBanner};
}
