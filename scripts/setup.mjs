import { writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const password = randomBytes(24).toString('base64url');
const content = `APP_ENV=test\nAUDAX_MODE=live\nLOCAL_DATA_DIR=./data/test\nPORT=3000\nHOST=127.0.0.1\nPUBLIC_ORIGIN=http://127.0.0.1:3000\nCOOKIE_SECURE=false\nADMIN_USERNAME=admin\nADMIN_PASSWORD=${password}\nWORKER_ENABLED=true\n`;
try {
  await writeFile('.env', content, { flag:'wx', mode:0o600 });
  await mkdir('data', { recursive:true });
  console.log('Configuración TEST creada. No se conectará a Audax.');
  console.log(`Usuario: admin\nContraseña inicial: ${password}`);
  console.log('Guardá esta contraseña. Ejecutá npm run dev y abrí http://127.0.0.1:3000');
} catch (error) {
  if (error.code === 'EEXIST') console.log('Ya existe .env. Se conserva tu configuración.');
  else throw error;
}

// Independent local PROD preview: no TEST credentials or data are copied.
const prodPassword=randomBytes(24).toString('base64url');
try {
  await writeFile('.env.prod.local',`APP_ENV=prod\nAUDAX_MODE=live\nLOCAL_PREVIEW=true\nLOCAL_DATA_DIR=./data/prod\nCONFIG_KEY_FILE=./data/audax-prod-config.key\nPORT=3001\nHOST=127.0.0.1\nPUBLIC_ORIGIN=http://127.0.0.1:3001\nCOOKIE_SECURE=false\nADMIN_USERNAME=admin\nADMIN_PASSWORD=${prodPassword}\nWORKER_ENABLED=true\n`,{flag:'wx',mode:0o600});
  console.log(`PROD local vacío: http://127.0.0.1:3001 · usuario admin · contraseña ${prodPassword}`);
} catch(error){if(error.code!=='EEXIST')throw error;}
console.log('Ambos entornos: npm run dev:both. PROD local no permite configurar credenciales ni enviar a Audax.');
