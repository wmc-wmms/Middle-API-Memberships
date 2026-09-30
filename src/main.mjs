/**
 * Entrada del servidor. Compone configuración, base, servicios y worker; cierra en orden para preservar persistencia.
 */
import { configFromEnv } from './config.mjs';
import { openDatabase } from './db.mjs';
import { buildApp } from './app.mjs';
import { createServices } from './services.mjs';
import { Worker } from './worker.mjs';
const config = configFromEnv();
const db = await openDatabase(config);
const services = await createServices(db,config);
const app = await buildApp({ db, config, ...services, logger: {
  level: 'info', redact: ['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]'],
} });
const worker = new Worker(db, services.gateway, config, services.catalogs);
if (config.workerEnabled) worker.start(() => app.log.error('Error del worker; el trabajo se conserva para recuperación'));
let closing = false;
async function close() { if (closing) return; closing = true; await worker.stop(); await app.close(); await db.close(); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
await app.listen({ port: config.port, host: config.host });
