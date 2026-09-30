# WMC + WMMS · Instalación y despliegue

## Repositorio

El proyecto está en la raíz del repositorio. Publicar código, assets, migraciones,
documentación y pnpm-lock.yaml. `.gitignore` excluye `.env`, claves, datos locales,
dependencias, capturas y paquetes ZIP. No incluirlos con `git add -f`.

```sh
git add .
git diff --cached --stat
git commit -m "Prepare WMC and WMMS membership gateway"
git remote add origin URL_DE_TU_REPOSITORIO
git push -u origin HEAD
```

`npm run check:repository` revisa los nombres de archivos publicables. La CI ejecuta
sintaxis, esta revisión, pruebas y construcción Docker en cada push/PR. No publica
el servicio ni copia credenciales a GitHub.

## Desarrollo local

Node.js 24 y pnpm 11.19.0:

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm run setup
pnpm run dev:both
```

TEST: http://127.0.0.1:3000. PROD local: http://127.0.0.1:3001.
`setup` muestra contraseñas aleatorias solo al crear cada configuración; no reemplaza
archivos existentes. Las dos bases locales son independientes. PROD local es una
vista sin envíos. PGlite es para uso local en un único proceso: alojar sus datos en
un directorio local sin sincronización concurrente, usando LOCAL_DATA_DIR y CONFIG_KEY_FILE.

## Servidor con PostgreSQL y HTTPS

Requisitos: servidor Linux con Docker Compose, dominio apuntando al servidor y
puertos 80/443 disponibles. Clonar el repositorio en el servidor. Para PROD:

1. Copiar `.env.prod.example` a `.env.prod`.
2. Completar ADMIN_PASSWORD, POSTGRES_PASSWORD y CONFIG_ENCRYPTION_KEY con valores
   independientes de TEST. La clave de cifrado y la contraseña de PostgreSQL deben
   ser hexadecimales aleatorias; generar cada una por separado:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Definir PUBLIC_DOMAIN como el dominio sin protocolo y PUBLIC_ORIGIN como su URL
   HTTPS. Configurar TEST_PORTAL_URL y PROD_PORTAL_URL con sus URLs reales.
   Mantener COOKIE_SECURE=true; no activar LOCAL_PREVIEW en el servidor.
4. Iniciar API, worker, PostgreSQL y proxy:

   ```sh
   docker compose --env-file .env.prod -p memberships-prod -f compose.yaml -f compose.public.yaml up -d --build
   docker compose --env-file .env.prod -p memberships-prod -f compose.yaml -f compose.public.yaml ps
   ```

5. Abrir el dominio e ingresar con el administrador configurado. En Conexión Audax,
   guardar las credenciales PROD de Portsoft y sincronizar. Asignar clientes y sus
   pares empresa/plan. No copiar credenciales ni memberships de TEST.

Para TEST público, usar `.env.test`, otro proyecto Compose, dominio y base. Si ambos
están en el mismo servidor, usar UN proxy frontal que enrute cada dominio a su API
(ejemplo de Caddy en `deploy/Caddyfile.example`), y levantar ambos con compose.yaml
sin compose.public.yaml para evitar que dos proxies ocupen los mismos puertos.

## Verificación y mantenimiento

- `/health` verifica HTTP; `/ready` verifica base y señal del worker. No confirma
  que las credenciales Audax sean válidas: eso se consulta desde Conexión Audax.
- Probar token y un lote autorizado en TEST, verificar ProcessID y resultado final.
- Descargar Postman desde la guía y verificar que base_url coincida con el dominio.
- Migraciones se aplican al iniciar, bajo lock de base. Respaldar PostgreSQL antes
  de actualizar; conservar CONFIG_ENCRYPTION_KEY junto a los backups protegidos.
- Actualizar: `git pull` y repetir `docker compose ... up -d --build`.
- Logs: `docker compose --env-file .env.prod -p memberships-prod logs --tail=100 api worker`.
- No ejecutar `down -v` para actualizaciones: eliminaría el volumen de la base.

Cada ambiente usa el mismo esquema en un volumen distinto. API y worker comparten
únicamente la base y clave de SU ambiente. Para varias réplicas de API, centralizar
los límites de solicitudes antes de escalar; la cola SQL ya coordina workers mediante leases.
