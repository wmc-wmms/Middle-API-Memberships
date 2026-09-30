/**
 * Worker separado sobre PostgreSQL. Comparte esquema, ambiente y clave de cifrado con su API; no comparte datos con otro ambiente.
 */
import { configFromEnv } from './config.mjs';
import { openDatabase } from './db.mjs';
import { createServices } from './services.mjs';
import { Worker } from './worker.mjs';
const config = configFromEnv();
if (!config.databaseUrl) throw new Error('Worker separado requiere PostgreSQL. Para la demo embebida usá npm run dev.');
const db = await openDatabase(config);
const services=await createServices(db,config);
const worker = new Worker(db, services.gateway, config, services.catalogs);
worker.start(() => console.error('Error del worker; revisar disponibilidad de PostgreSQL y configuración'));
let closing = false;
async function close() { if (closing) return; closing = true; await worker.stop(); await db.close(); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
