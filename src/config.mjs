/**
 * Configuración por proceso. El ambiente fija la URL oficial; ningún header puede cambiarlo. PROD local es una vista sin envíos.
 */
export const AUDAX_URLS = {

  test: 'https://mpool-testapi-audax.portsoft.net/api',

  prod: 'https://mpool-api-audax.portsoft.net/api',

};

export function configFromEnv(env = process.env) {

  const environment = env.APP_ENV || 'test';

  if (!['test', 'prod'].includes(environment)) throw new Error('APP_ENV debe ser test o prod');

  const mode = env.AUDAX_MODE || 'live';

  if (!['mock', 'live'].includes(mode)) throw new Error('AUDAX_MODE debe ser mock o live');

  const config = {

    environment, mode,

    useCatalogs: mode === 'live',

    localPreview: environment === 'prod' && env.LOCAL_PREVIEW === 'true',

    testPortalUrl: env.TEST_PORTAL_URL || 'http://127.0.0.1:3000',

    prodPortalUrl: env.PROD_PORTAL_URL || 'http://127.0.0.1:3001',

    allowTestLiveMigration: env.ALLOW_TEST_LIVE_MIGRATION === 'true',

    encryptionKey: env.CONFIG_ENCRYPTION_KEY || '',

    encryptionKeyFile: env.CONFIG_KEY_FILE || `./data/audax-${environment}-config.key`,

    databaseUrl: env.DATABASE_URL || '',

    localData: env.LOCAL_DATA_DIR || `./data/${environment}`,

    port: Number(env.PORT || 3000), host: env.HOST || '127.0.0.1',

    publicOrigin: env.PUBLIC_ORIGIN || 'http://localhost:3000',

    secureCookies: env.COOKIE_SECURE === 'true',

    adminUsername: env.ADMIN_USERNAME || '', adminPassword: env.ADMIN_PASSWORD || '',

    audaxBaseUrl: AUDAX_URLS[environment],

    audaxTokenUrl: 'https://login.microsoftonline.com/bbd9f62f-45ea-419d-a872-a48059e91a9a/oauth2/v2.0/token',

    audaxClientId: env.AUDAX_CLIENT_ID || '', audaxClientSecret: env.AUDAX_CLIENT_SECRET || '',

    audaxScope: env.AUDAX_SCOPE || '',

    allowOverride: env.AUDAX_ALLOW_OVERRIDE === 'true',

    workerEnabled: env.WORKER_ENABLED !== 'false',

    pollMs: 5000, requestTimeoutMs: 20000, maxAttempts: 8,

    maxPollAgeMs: 24 * 60 * 60 * 1000, maxBatch: 500, tokenTtlSeconds: 3600,

  };

  if (config.adminPassword && config.adminPassword.length < 16) throw new Error('ADMIN_PASSWORD requiere al menos 16 caracteres');

  if (environment === 'prod' && !config.localPreview && (!config.databaseUrl || mode !== 'live' || !config.secureCookies || !config.publicOrigin.startsWith('https://'))) {

    throw new Error('Producción requiere PostgreSQL, AUDAX_MODE=live, COOKIE_SECURE=true y PUBLIC_ORIGIN HTTPS');

  }

  // Local PROD is a blank preview only. Official production calls require PostgreSQL and HTTPS.

  if(config.localPreview && (config.databaseUrl || !['127.0.0.1','localhost'].includes(config.host) || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(config.publicOrigin) || config.audaxClientId || config.audaxClientSecret))throw new Error('Vista local PROD requiere loopback y no admite credenciales oficiales');

  for(const url of [config.testPortalUrl,config.prodPortalUrl])if(!['http:','https:'].includes(new URL(url).protocol))throw new Error('URL de entorno inválida');

  return config;

}

