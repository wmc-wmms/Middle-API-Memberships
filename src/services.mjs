/**
 * Compone dependencias por ambiente. Cada proceso recibe su base; fetch se inyecta en pruebas para evitar llamadas oficiales.
 */
import { LiveAudax, MockAudax } from './audax.mjs';
import { AudaxSettings, ManagedAudax, settingsKey } from './settings.mjs';
import { CatalogService } from './catalogs.mjs';
export async function createServices(db,config,fetcher=fetch) {
  if(!config.useCatalogs)return {gateway:config.mode==='mock'?new MockAudax(db):new LiveAudax(config,fetcher)};
  const settings=new AudaxSettings(db,config,await settingsKey(config),fetcher);
  await settings.bootstrap();
  return {settings,catalogs:new CatalogService(db,settings),gateway:new ManagedAudax(settings)};
}
