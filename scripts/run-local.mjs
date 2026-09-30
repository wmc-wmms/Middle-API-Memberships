/** Inicia dos procesos idénticos con configuración, base y puerto independientes. */
import {spawn} from 'node:child_process';
const children=['.env','.env.prod.local'].map(file=>spawn(process.execPath,[`--env-file=${file}`,'src/main.mjs'],{stdio:'inherit',windowsHide:true}));
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');}
for(const child of children){child.on('error',error=>{console.error(error.message);stop();process.exitCode=1});child.on('exit',code=>{if(!stopping){stop();process.exitCode=code||0}});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
