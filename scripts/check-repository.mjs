/** Verifica el contenido que Git puede publicar; no lee ni imprime secretos. */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
// --stdin permite usar Git desde el shell cuando el entorno restringe subprocesos.
const paths=process.argv.includes('--stdin')
  ? readFileSync(0,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)
  : execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=paths.filter(path=>{
  const parts=path.split('/'),name=parts.at(-1);
  return parts.some(part=>['node_modules','data'].includes(part)) ||
    (name.startsWith('.env')&&!name.endsWith('.example')) ||
    /\.(key|pem|pfx|p12|zip)$/i.test(name) || name==='ACCESO-LOCAL.txt';
});
if(forbidden.length){console.error('Archivos privados o generados fuera de las exclusiones:',forbidden.join(', '));process.exit(1);}
console.log('Repositorio verificado: configuración privada, claves y bases excluidas.');
