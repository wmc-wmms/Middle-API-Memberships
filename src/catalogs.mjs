/**
 * Publicación atómica de catálogos. GetPlans se agrupa por business_id; las relaciones provienen de Audax. Este módulo no modifica memberships.
 */
import { randomUUID } from 'node:crypto';

import { fail, audit } from './security.mjs';

import { connectionError } from './settings.mjs';



export const CATALOGS = {

  business:{endpoint:'GetBusiness',id:'business_id',label:'Empresas'},

  plans:{endpoint:'GetPlans',id:'membership_plan_id',label:'Planes'},

  countries:{endpoint:'GetCountries',id:'country_id',label:'Países'},

  currencies:{endpoint:'GetCurrencies',id:'currency_id',label:'Monedas'},

  locations:{endpoint:'GetLocationGroups',id:'location_group_id',label:'Grupos de ubicación'},

  conditions:{endpoint:'GetConditions',id:'condition_id',label:'Condiciones'},

};

const json = JSON.stringify;

function externalId(value) {

  if (typeof value === 'string' && value.trim() && value.length<=128) return value.trim();

  if (typeof value === 'number' && Number.isSafeInteger(value) && value>=0) return String(value);

  throw new Error('Identificador de catálogo no válido');

}

export function normalizeCatalog(type, body) {

  if(type==='plans') {

    if(!body || typeof body!=='object' || Array.isArray(body))throw new Error('GetPlans debe devolver un objeto agrupado por business_id');

    const plans=new Map();

    for(const [rawBusiness,rows] of Object.entries(body)) {

      const business=externalId(rawBusiness),seen=new Set();

      if(!Array.isArray(rows))throw new Error('Cada business de GetPlans debe contener un array');

      for(const row of rows) {

        if(!row || typeof row!=='object' || Array.isArray(row))throw new Error('Plan no válido');

        const id=externalId(row.membership_plan_id);

        if(typeof row.name!=='string'||!row.name.trim()||row.name.length>1000)throw new Error('Nombre de plan no válido');

        if(seen.has(id))throw new Error('Plan duplicado dentro del mismo business');

        seen.add(id);

        const previous=plans.get(id);

        if(previous) {

          if(previous.name!==row.name.trim())throw new Error('El mismo plan tiene nombres inconsistentes entre businesses');

          previous.data.business_ids.push(business);

        } else plans.set(id,{id,name:row.name.trim(),data:{...row,business_id:undefined,business_ids:[business]}});

      }

    }

    return [...plans.values()];

  }

  if (!Array.isArray(body)) throw new Error(`${CATALOGS[type].endpoint} debe devolver un array`);

  const seen = new Set();

  return body.map(row => {

    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Registro de catálogo no válido');

    const id = externalId(row[CATALOGS[type].id]);

    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length>1000) throw new Error('Nombre de catálogo no válido');

    if (seen.has(id)) throw new Error(`ID duplicado en ${CATALOGS[type].endpoint}`);

    seen.add(id); return { id, name:row.name.trim(), data:row };

  });

}

function normalizeUpgrades(body) {

  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Catálogo de upgrades no válido');

  const rows=[],seen=new Set();

  for (const [business,list] of Object.entries(body)) {

    const businessId=externalId(business);

    if (!Array.isArray(list)) throw new Error('Lista de upgrades no válida');

    for (const row of list) {

      const id=externalId(row.upgrade_id), key=json([businessId,id]);

      if(seen.has(key)) throw new Error('Upgrade duplicado');

      seen.add(key);rows.push({id:key,name:row.name || `Upgrade ${id}`,data:{...row,business_id:businessId,upgrade_id:id}});

    }

  }

  return rows;

}

export class CatalogService {

  constructor(db,settings) { Object.assign(this,{db,settings});this.running=false; }

  async requestSync(actor) {

    return this.db.transaction(async tx => {

      const s=(await tx.query('SELECT * FROM audax_settings WHERE id=1 FOR SHARE')).rows[0];

      if(!s.secret_encrypted)throw fail(400,'connection_not_configured','Guardá las credenciales de Audax antes de sincronizar');

      const existing=(await tx.query("SELECT * FROM catalog_sync_runs WHERE status IN ('queued','running') LIMIT 1")).rows[0];

      if(existing)return existing;

      const id=randomUUID();

      // The unique partial index also covers requests from multiple API instances.

      const r=await tx.query(`INSERT INTO catalog_sync_runs(id,fingerprint,settings_revision,status,requested_by)

        VALUES($1,$2,$3,'queued',$4) ON CONFLICT DO NOTHING RETURNING *`,[id,s.fingerprint,s.revision,actor]);

      if(!r.rows.length)return (await tx.query("SELECT * FROM catalog_sync_runs WHERE status IN ('queued','running') LIMIT 1")).rows[0];

      await audit(tx,actor,'catalog.sync_requested',id);return r.rows[0];

    });

  }

  async snapshot() {

    const s=await this.settings.record();

    const rows=(await this.db.query('SELECT catalog,external_id AS id,name,data,synced_at FROM catalog_entries WHERE fingerprint=$1 AND active=true ORDER BY catalog,name,external_id',[s.fingerprint])).rows;

    const result=Object.fromEntries([...Object.keys(CATALOGS),'upgrades'].map(k=>[k,[]]));

    for(const row of rows)result[row.catalog]?.push(row);

    const links=(await this.db.query(`SELECT l.business_id,l.plan_id,l.source FROM business_plan_links l

      JOIN catalog_entries b ON b.fingerprint=l.fingerprint AND b.catalog='business' AND b.external_id=l.business_id AND b.active

      JOIN catalog_entries p ON p.fingerprint=l.fingerprint AND p.catalog='plans' AND p.external_id=l.plan_id AND p.active

      WHERE l.fingerprint=$1 ORDER BY l.business_id,l.plan_id`,[s.fingerprint])).rows;

    const latest=(await this.db.query('SELECT * FROM catalog_sync_runs WHERE fingerprint=$1 ORDER BY created_at DESC LIMIT 1',[s.fingerprint])).rows[0]||null;

    const successful=(await this.db.query("SELECT finished_at FROM catalog_sync_runs WHERE fingerprint=$1 AND status='finished' ORDER BY finished_at DESC LIMIT 1",[s.fingerprint])).rows[0];

    return { environment:this.settings.config.environment,catalogs:result,business_plans:links,last_run:latest,last_success_at:successful?.finished_at||null };

  }

  async tick() {

    if(this.running)return false;

    this.running=true;let run;

    try {

      await this.db.query("UPDATE catalog_sync_runs SET status='failed',error='La sincronización fue interrumpida. Volvé a sincronizar.',finished_at=now(),lease_id=NULL,lease_until=NULL WHERE status='running' AND lease_until<now()");

      run=await this.db.transaction(async tx=>{

        const row=(await tx.query("SELECT * FROM catalog_sync_runs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];

        if(!row)return null;

        row.lease_id=randomUUID();

        await tx.query("UPDATE catalog_sync_runs SET status='running',lease_id=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",[row.id,row.lease_id]);return row;

      });

      if(!run)return false;

      const {adapter,record}=await this.settings.adapter(run.fingerprint);

      if(record.revision!==run.settings_revision)throw new Error('La configuración cambió durante la sincronización');

      const types=Object.keys(CATALOGS),normalized={};

      const results=await Promise.allSettled([...types.map(k=>adapter.catalog(CATALOGS[k].endpoint)),adapter.catalog('GetUpgrades')]);

      const failures=[],warnings=[];

      for(const [i,type] of types.entries()) {

        const r=results[i];

        if(r.status==='rejected'){failures.push(`${CATALOGS[type].endpoint}: ${connectionError(r.reason)}`);continue;}

        try{normalized[type]=normalizeCatalog(type,r.value.body);}catch{failures.push(`${CATALOGS[type].endpoint}: estructura de catálogo no válida o IDs duplicados.`);}

      }

      if(failures.length)throw new Error(failures.join(' '));

      const knownBusiness=new Set(normalized.business.map(b=>b.id));

      const plansResponse=results[types.indexOf('plans')].value.body;

      if(Object.keys(plansResponse).some(id=>!knownBusiness.has(externalId(id))))throw new Error('GetPlans incluye un business ausente de GetBusiness. No se actualizaron los catálogos.');

      const upgrades=results.at(-1);

      try{if(upgrades.status==='rejected')throw upgrades.reason;normalized.upgrades=normalizeUpgrades(upgrades.value.body);}

      catch{warnings.push('GetUpgrades no pudo sincronizarse. Los seis catálogos principales sí fueron actualizados.');}

      await this.db.transaction(async tx=>{

        const current=(await tx.query('SELECT * FROM audax_settings WHERE id=1 FOR UPDATE')).rows[0];

        if(current.revision!==run.settings_revision)throw new Error('La configuración cambió. Volvé a sincronizar con las nuevas credenciales.');

        const owned=(await tx.query("SELECT id FROM catalog_sync_runs WHERE id=$1 AND lease_id=$2 AND status='running' FOR UPDATE",[run.id,run.lease_id])).rows[0];

        if(!owned)return;

        // Publish all six catalogs atomically; keep the previous snapshot intact on any required failure.

        await tx.query('UPDATE catalog_entries SET active=false WHERE fingerprint=$1',[run.fingerprint]);

        for(const [type,entries] of Object.entries(normalized))for(const e of entries)await tx.query(`INSERT INTO catalog_entries(fingerprint,catalog,external_id,name,data)

          VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(fingerprint,catalog,external_id)

          DO UPDATE SET name=EXCLUDED.name,data=EXCLUDED.data,active=true,synced_at=now()`,[run.fingerprint,type,e.id,e.name,json(e.data)]);

        await tx.query("DELETE FROM business_plan_links WHERE fingerprint=$1",[run.fingerprint]);

        const businesses=new Set(normalized.business.map(b=>b.id));

        for(const plan of normalized.plans){

          // The grouping key in GetPlans is the authoritative business ID.

          const links=plan.data.business_id!==undefined?[plan.data.business_id]:Array.isArray(plan.data.business_ids)?plan.data.business_ids:[];

          for(const raw of links){const business=externalId(raw);if(!businesses.has(business))continue;

            await tx.query(`INSERT INTO business_plan_links(fingerprint,business_id,plan_id,source) VALUES($1,$2,$3,'audax')

              ON CONFLICT(fingerprint,business_id,plan_id) DO UPDATE SET source='audax',updated_at=now()`,[run.fingerprint,business,plan.id]);

          }

        }

        const counts=Object.fromEntries(Object.entries(normalized).map(([k,v])=>[k,v.length]));

        await tx.query("UPDATE catalog_sync_runs SET status='finished',counts=$3::jsonb,warnings=$4::jsonb,finished_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",[run.id,run.lease_id,json(counts),json(warnings)]);

        await tx.query('UPDATE audax_settings SET verified_at=now(),last_error=NULL WHERE id=1');

        await audit(tx,run.requested_by,'catalog.sync_finished',run.id,{counts,warnings});

      });

      return true;

    }catch(error){

      if(!run)throw error;

      // Only locally constructed messages are retained; never persist a provider token/error body containing secrets.

      const message=error instanceof Error && error.name==='Error'?error.message:'No se pudo sincronizar Audax. Revisá conexión y credenciales.';

      await this.db.query("UPDATE catalog_sync_runs SET status='failed',error=$3,finished_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",[run.id,run.lease_id,message.slice(0,4000)]);

      return true;

    }finally{this.running=false;}

  }

}



export async function validateClientCatalog(db,body,config) {

  if(!config.useCatalogs)return body;

  const s=(await db.query('SELECT * FROM audax_settings WHERE id=1 FOR SHARE')).rows[0];

  const allowed=(await db.query(`SELECT l.business_id,l.plan_id FROM business_plan_links l

    JOIN catalog_entries b ON b.fingerprint=l.fingerprint AND b.catalog='business' AND b.external_id=l.business_id AND b.active

    JOIN catalog_entries p ON p.fingerprint=l.fingerprint AND p.catalog='plans' AND p.external_id=l.plan_id AND p.active

    WHERE l.fingerprint=$1`,[s.fingerprint])).rows;

  if(!body.business_plan_pairs?.length)throw fail(400,'business_plans_required','Seleccioná un business y sus planes reales del catálogo');

  const pairs=body.business_plan_pairs;

  for(const pair of pairs)if(!allowed.some(a=>a.business_id===pair.business_id&&a.plan_id===pair.plan_id))throw fail(400,'business_plan_not_allowed','Hay una combinación empresa/plan no asociada en los catálogos locales');

  const businesses=[...new Set(pairs.map(p=>p.business_id))],plans=[...new Set(pairs.map(p=>p.plan_id))];

  if(body.business_ids.some(b=>!businesses.includes(b))||body.plan_ids.some(p=>!plans.includes(p))||businesses.some(b=>!body.business_ids.includes(b))||plans.some(p=>!body.plan_ids.includes(p)))throw fail(400,'inconsistent_permissions','Las empresas y planes deben coincidir con las combinaciones seleccionadas');

  return body;

}

export async function validateMembershipCatalog(db,config,client,items) {

  if(!config.useCatalogs)return null;

  const s=(await db.query('SELECT * FROM audax_settings WHERE id=1 FOR SHARE')).rows[0];

  if(!s.secret_encrypted||!s.verified_at)throw fail(409,'connection_not_ready','Configurá y probá la conexión a Audax antes de enviar memberships');

  // Validate only the submitted pairs; unrelated permissions/catalog entries must not block this membership.

  const entries=(await db.query('SELECT catalog,external_id,data FROM catalog_entries WHERE fingerprint=$1 AND active',[s.fingerprint])).rows;

  const has=(kind,id)=>entries.some(e=>e.catalog===kind&&e.external_id===String(id));

  for(const item of items){

    if(!client.business_plan_pairs.some(p=>p.business_id===item.business_id&&p.plan_id===item.plan_id))throw fail(403,'business_plan_forbidden','La combinación business/plan no está habilitada para este usuario');

    const relation=(await db.query('SELECT 1 FROM business_plan_links WHERE fingerprint=$1 AND business_id=$2 AND plan_id=$3',[s.fingerprint,item.business_id,item.plan_id])).rows.length;

    if(!relation||!has('business',item.business_id)||!has('plans',item.plan_id))throw fail(400,'unknown_business_plan','El business y plan enviados no están en el catálogo vigente');

    if(!has('countries',item.issued_country))throw fail(400,'unknown_country','Seleccioná un país del catálogo real');

    if(item.currency_id!==undefined&&!has('currencies',item.currency_id))throw fail(400,'unknown_currency','Seleccioná una moneda del catálogo real');

    for(const upgrade of item.upgrades||[])for(const [id,data] of Object.entries(upgrade)){

      if(!has('upgrades',json([item.business_id,id])))throw fail(400,'unknown_upgrade','El upgrade no está disponible para este business en el catálogo sincronizado');

      if(data.currency_id!==undefined&&!has('currencies',data.currency_id))throw fail(400,'unknown_currency','Moneda de upgrade no disponible');

    }

  }

  return s.fingerprint;

}

