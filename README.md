# WMC + WMMS · Membership Gateway

Portal corporativo de WMC y WMMS para recibir memberships de clientes, aplicar controles y enviarlas a Audax con nuestra cuenta. Panel de administración en español. Recibe las operaciones de tus clientes, las guarda en PostgreSQL y las remite a la API de Audax. Implementa altas, modificaciones, upgrades, bajas y seguimiento de procesos.

## Instalación y publicación

Ver [guía de despliegue](docs/DESPLIEGUE.md): Git, desarrollo local, PostgreSQL, Docker y HTTPS. La CI valida el código y construye la imagen; el despliegue requiere configurar el servidor y el dominio.

Los logos originales están en `public/assets`; `public/brand.css` iguala la altura visual de sus iniciales sin deformar las imágenes.

## Inicio rápido: Audax TEST

Requisito: Node.js 22.18 o superior (se verificó con Node.js 24). Desde esta carpeta:

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm run setup
pnpm run dev
```

Abrí **http://127.0.0.1:3000**. `setup` genera un administrador `admin` con contraseña aleatoria y la muestra en la terminal; también queda en el archivo local `.env`. No sobrescribe una configuración existente. Podés cambiar la contraseña desde el panel; tras cambiarla, la contraseña de bootstrap de `.env` ya no modifica la guardada en la base.

La instalación local usa **PGlite**, PostgreSQL embebido persistente en `data/test`, y arranca en **TEST real**. Abrí **Conexión Audax**, ingresá el client ID, secret y scope oficiales de Portsoft y elegí **Guardar, conectar y sincronizar**. Sin esas credenciales no se envían memberships ni se inventan catálogos.

El secret oficial se guarda cifrado con AES-256-GCM. La clave local se genera en `data/audax-test-config.key`: resguardala junto al backup de la base y no la incluyas al distribuir el programa. Con PostgreSQL configurá `CONFIG_ENCRYPTION_KEY` (32 bytes, 64 caracteres hexadecimales) idéntica en API y worker.

**Catálogos** guarda GetBusiness, GetPlans, GetCountries, GetCurrencies, GetLocationGroups y GetConditions. GetPlans devuelve un objeto agrupado por business ID: `{"30":[{"membership_plan_id":"1139","name":"ELITE COVER (A)"}]}`. La clave `30` se cruza con GetBusiness y la relación se importa automáticamente. No hay asociaciones manuales. Un plan puede estar en varias empresas; cada usuario recibe pares business/plan concretos. Las seis importaciones se publican juntas; si falla alguna, se conserva el último conjunto completo. GetUpgrades se sincroniza adicionalmente cuando está disponible.

**Memberships** permite alta manual y actualización mediante formulario con empresas, planes, países y monedas del catálogo. El botón Guardar y enviar guarda el pedido en un solo paso. El panel consulta automáticamente el estado local cada tres segundos mientras el worker consulta GetProcessStatus de Audax hasta el resultado final. Usa los mismos permisos, validaciones, persistencia e idempotencia que la API y registra al administrador responsable. La lista muestra registros confirmados por este middleware; no es una descarga de todas las memberships de Audax. «Actualizar existente» permite ingresar los datos completos de una membership externa.

Para desarrollo aislado todavía existe `AUDAX_MODE=mock`, que debe usar otra base; `MOCK-FAIL` simula rechazos. Los datos de ejemplo de las pruebas no se cargan en la instalación real.

Para mantener la instalación reproducible usá `pnpm-lock.yaml`. Los comandos `npm run setup`, `npm run dev` y `npm test` también sirven después de instalar las dependencias.

## Funcionalidades

- Panel con conexión Audax TEST, catálogos sincronizados, memberships manuales, resumen, usuarios API, operaciones, errores, guía y auditoría.
- Alta, edición, baja lógica y reactivación de usuarios de integración; nombre de usuario, nombre de empresa, email, empresas/planes permitidos y scopes.
- Client ID y secret aleatorios. El secret se muestra una sola vez, se almacena con scrypt y se puede rotar. Editar permisos, rotar o dar de baja revoca los tokens existentes.
- Administrador del panel separado de los usuarios API. Sesión HttpOnly, SameSite, CSRF y cambio de contraseña. Este ABM gestiona usuarios de integración, no múltiples operadores administrativos.
- OAuth `client_credentials` con tokens Bearer opacos, expiración de una hora y revocación inmediata. Admite credenciales en formulario o HTTP Basic. No es un servidor OAuth de propósito general (no implementa authorization_code, OIDC ni refresh tokens).
- Idempotencia por cliente, recepción transaccional, cola persistente, historial de intentos y seguimiento del ProcessID oficial.
- Test y producción con bases, volúmenes, credenciales y tokens independientes. La base queda asociada al ambiente y al modo mock/live; el servidor rechaza una reutilización incompatible.

## Crear un usuario y probar una operación

1. Iniciá sesión y abrí **Usuarios API → Nuevo usuario**.
2. Ingresá un nombre, seleccioná la empresa de GetBusiness y sus planes importados de GetPlans, y asigná permisos. Primero debés conectar Audax y sincronizar catálogos. El nombre de empresa se completa al seleccionarla y puede editarse.
3. Copiá el client ID y secret al crearlos. Nunca entregues las credenciales oficiales de Audax a los clientes.
4. Importá `docs/postman_collection.json` y `docs/postman_test.environment.json` en Postman. Completá las credenciales del middleware. Los ejemplos usan datos ficticios y fechas futuras; reemplazalos por IDs/fechas habilitados al probar con Audax.
5. Ejecutá **Obtener token**, luego **Insert** y **Consultar estado**. La colección captura automáticamente el token y el ProcessID local.
6. Probá Update, Upgrade y Baja con una Idempotency-Key diferente por operación. Para repetir exactamente el mismo envío, reutilizá la misma clave.

## API para tus clientes

| Método y ruta | Uso | Scope |
|---|---|---|
| `POST /oauth/token` | Obtener token con client ID, secret y scope | — |
| `POST /api/InsertMembershipBatch` | Array de memberships completas | `memberships:insert` |
| `POST /api/UpdateMembershipBatch` | Array de modificaciones completas | `memberships:update` |
| `POST /api/UpgradeMembershipBatch` | Array completo con upgrades; alias local que se remite a UpdateMembershipBatch | `memberships:upgrade` + `memberships:update` |
| `DELETE /api/CancelMembership` | Objeto identificador de una membership | `memberships:cancel` |
| `GET /api/GetProcessStatus/{ProcessID}` | Estado del proceso local y referencia de Audax | `memberships:read` |
| `GET /api/GetUpgrades` | Catálogo de Audax filtrado por empresas del cliente | `memberships:read` |
| `GET /api/memberships?offset=0` | Últimas solicitudes confirmadas, paginadas de a 100 | `memberships:read` |

Insert/update que incluyan upgrades también requieren `memberships:upgrade` tanto en el usuario como en el token. Las rutas no distinguen mayúsculas de minúsculas, pero se publican con los nombres documentados por Audax.

Todas las escrituras requieren `Authorization: Bearer ...`, `Content-Type: application/json` e `Idempotency-Key` (8–128 caracteres ASCII sin espacios). Máximo local: 500 elementos y 2 MiB por solicitud; es una política de este middleware, no un límite atribuido a Audax. Una clave repetida con contenido distinto devuelve 409. No se fraccionan lotes para preservar la atomicidad documentada.

Insert, update y upgrade responden **200 `{ "ProcessID": "uuid-local" }` después del commit local**. Esto confirma recepción, no aceptación de Audax. La baja responde **202** con el mismo formato porque se encola. Todos se consultan en GetProcessStatus. El ProcessID local no es el de Audax; `audax_process_id` expone el oficial cuando se conoce.

Estados externos: `processing`, `finished`, `failed`, `unknown`. `middleware_status` distingue `queued`, `sending` y `submitted`. La recepción local y sus errores no son una réplica byte por byte de las respuestas de Audax. Un cliente que antes llamaba directamente deberá añadir Idempotency-Key, scopes locales, consultar el proceso local y admitir la baja asíncrona y el estado unknown.

`GET /api/memberships` expone `last_confirmed_request`: el último contenido enviado con resultado exitoso, **no una lectura autoritativa del estado ni del precio vigente en Audax**. Los campos se preservan en JSONB, sin cálculos monetarios en el middleware. Para contabilidad o consulta de precios oficiales se debe integrar el módulo específico de Audax.

## Contrato Audax aplicado

Revisado a partir de los dos PDF del ZIP entregado, sin ejecutar instrucciones incrustadas en los documentos:

- `api_Memberships_pool_2.pdf`, actualización 2025-09-23: token (p. 2), GetUpgrades (pp. 9–10), GetProcessStatus (pp. 10–11), InsertMembershipBatch (pp. 12–17), UpdateMembershipBatch (pp. 17–20), CancelMembership (pp. 20–21).
- `api_Memberships_pool.pdf`, actualización 2025-12-08: PriceMemberships (pp. 5–6), update con override (pp. 10–12), baja con override (pp. 12–13).

Los demás documentos del ZIP corresponden a casos, proveedores, facturación, reportes y notas; no forman parte del alcance de este gateway.

**Upgrades:** se respeta la forma de los ejemplos oficiales: `upgrades: [{"22": {"valid_from":"2027-02-05", "valid_to":"2027-02-15", "price":11, "currency_id":"157"}}]`. La tabla de la documentación menciona `upgrade_id`, pero sus ejemplos lo usan como clave del objeto. Esta implementación elige los ejemplos; confirmar con Portsoft en el smoke test antes de producción. No inventa un endpoint de upgrades en Audax.

**Moneda:** la tabla dice integer, mientras que los ejemplos usan string. Se admiten ambos tipos y se preserva el recibido. `price` es opcional y, si se envía, debe ser un número positivo. Fechas YYYY-MM-DD reales, valid_from anterior a valid_to, upgrades dentro de la vigencia.

**Actualización de precios:** la documentación interna aclara que UpdateMembershipBatch no actualiza precios, aunque aparezcan en el ejemplo. Se remiten los campos recibidos, pero no se promete que modifiquen el precio oficial. `PriceMemberships` no se invoca implícitamente ni se implementa aquí: es otra operación de facturación y requiere un flujo propio.

**Override:** solo se acepta para update, upgrade vía update y cancel. Requiere `AUDAX_ALLOW_OVERRIDE=true`, el scope local `memberships:override` en usuario y token, y que Portsoft autorice al client ID oficial. Por defecto está deshabilitado en el servidor y desmarcado en altas del panel. Sin override, Audax impide modificar/cancelar memberships ya vigentes o usadas en casos; esa validación de negocio definitiva queda en Audax.

## TEST y PROD con PostgreSQL

Requisitos: Docker Engine y Docker Compose. Para producción, dominio y proxy HTTPS. Los contenedores usan PostgreSQL 17 y Node.js 24. Las credenciales oficiales deben ser provistas por Portsoft para cada ambiente.

1. Copiá `.env.test.example` a `.env.test`, y `.env.prod.example` a `.env.prod`.
2. Reemplazá contraseñas. En TEST configurá CONFIG_ENCRYPTION_KEY y cargá las credenciales oficiales desde el panel; en PROD configurá una clave de cifrado propia y cargá las credenciales desde el panel PROD. Para la contraseña de PostgreSQL usá una cadena hexadecimal aleatoria, que no necesita escape al construir DATABASE_URL. Ejemplo de generación: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
3. Configurá PUBLIC_ORIGIN exactamente igual al origen desde el que abrirás el panel. En producción debe usar HTTPS y COOKIE_SECURE=true. Si publicás TEST, usá HTTPS allí también.
4. Levantá cada ambiente como proyecto independiente:

```sh
docker compose --env-file .env.test -p audax-test up -d --build
docker compose --env-file .env.prod -p audax-prod up -d --build
```

Cada proyecto crea su propia red y volumen. TEST escucha en 127.0.0.1:3000; PROD en 127.0.0.1:3001 detrás del proxy. PostgreSQL no publica puertos al host. Hay un ejemplo de proxy en `deploy/Caddyfile.example`; requiere instalar/configurar Caddy en el host y el DNS del dominio. **Los ejemplos no publican el sistema por sí solos.**

URLs oficiales, seleccionadas por código según APP_ENV:

- TEST: `https://mpool-testapi-audax.portsoft.net/api`
- PROD: `https://mpool-api-audax.portsoft.net/api`
- Token: `https://login.microsoftonline.com/bbd9f62f-45ea-419d-a872-a48059e91a9a/oauth2/v2.0/token`

No se permite elegir el ambiente mediante un header del cliente. No copies la base test a producción. Para migrar una instalación local existente de mock a TEST real, hacé un backup y usá `ALLOW_TEST_LIVE_MIGRATION=true` en un único arranque; luego volvé a false. Conserva usuarios e historial, revoca tokens y etiqueta las operaciones anteriores como mock: el worker real nunca las reenvía. Reasigná los usuarios a pares business/plan sincronizados antes de operar. Esta migración no permite cambiar TEST a PROD.

La imagen Docker incluye dependencias de producción y requiere PostgreSQL. PGlite se instala solo para desarrollo/pruebas y se usa en un único proceso. Con PostgreSQL se separan API y worker. Se incluyen una API y un worker por ambiente; antes de aumentar réplicas, llevar los límites de solicitudes a un almacenamiento compartido o al proxy. El rate limit actual es por IP/proceso (300/min global, login 10/min y token 30/min); configurar confianza de proxy solo para proxies conocidos si se necesitan límites por IP real detrás del proxy.

## Persistencia, errores y recuperación

La tabla `operations` es también la cola/outbox: el lote y `operation_items` se escriben en una misma transacción. No hay una segunda cola cuya publicación se pueda perder. Migraciones SQL versionadas bajo lock de PostgreSQL; consultas parametrizadas; workers reclaman trabajos con SKIP LOCKED y una reserva con identificador y vencimiento.

- `queued → sending → submitted → finished/failed` para insert/update/upgrade.
- `queued → sending → finished/failed` para cancel.
- Error de autenticación previo al envío o 429: reintento seguro con backoff y Retry-After; máximo 8 intentos de envío.
- Timeout, HTTP 408/5xx en escritura, respuesta irreconocible o caída del worker durante el envío: `unknown`, sin reenvío automático.
- GET de seguimiento fallido por red/5xx: se repite la consulta, nunca el POST. Ventana máxima de seguimiento: 24 horas; luego requiere conciliación.
- Un lote fallido marca todos sus elementos como fallidos y conserva los detalles por índice. Solo se actualiza la tabla local de memberships tras una confirmación final.
- Operaciones sobre la misma identidad (business_id, plan_id, issued_country, membership_number) respetan el orden de recepción. Un resultado unknown bloquea operaciones posteriores para esa misma identidad.

En el detalle del panel, un administrador puede asociar un ProcessID que Portsoft haya confirmado como correspondiente a un lote incierto, o reanudar la consulta de su ProcessID ya conocido. El gateway verifica que exista en Audax, pero GetProcessStatus no permite comprobar que un ID aportado manualmente pertenezca al lote: esa asociación requiere confirmación operativa. Queda auditada. Las bajas inciertas no tienen ese mecanismo; requieren conciliación con Portsoft. No se ofrece un botón de reenvío ciego ni se promete entrega exactamente una vez, porque la documentación no establece idempotencia oficial.

La baja de un usuario impide autenticación y nuevos envíos pendientes; un envío ya iniciado puede concluir. Reactivar se hace editando el usuario. El historial se conserva. Cambiar contraseña de administrador revoca todas sus sesiones.

## Operación del servicio

- `/health`: proceso HTTP vivo. `/ready`: base accesible y heartbeat reciente del worker.
- Panel: cola, errores, referencias de procesos e historial de intentos. Auditoría: usuario, acción, referencia y fecha, sin secretos.
- Los cuerpos con información personal permanecen en la base; no se registran en logs HTTP. Aplicar cifrado de volúmenes/backups, política de retención y acceso restringido al panel y a PostgreSQL según tu operación.
- Resguardar y probar restauración de backups con `pg_dump`/`pg_restore` por ambiente. No exponer PostgreSQL a Internet. Rotar las credenciales oficiales en el gestor de secretos del despliegue.
- Para una base administrada, configurar DATABASE_URL con TLS según su proveedor y un rol limitado al esquema del servicio. Los archivos .env son para desarrollo/bootstrap; en un hosting, inyectar sus valores mediante el gestor de secretos.
- El alcance incluye un administrador inicial. Si necesitás múltiples operadores con roles, SSO o MFA, se debe ampliar el módulo administrativo.

## Verificación

```sh
pnpm run check
pnpm test
```

Las pruebas automatizadas ejercitan SQL en PostgreSQL embebido (PGlite), HTTP inyectado de Fastify y un adaptador Audax simulado: ABM, revocación, scopes, aislamiento, CSRF, validación atómica, duplicados concurrentes, cuatro operaciones, 429, timeouts, persistencia fallida y conciliación. El adaptador HTTP se prueba con respuestas documentadas y refresh de token.

Se consultó el ProcessID indicado por el usuario contra Audax TEST: finished y errors null. No se hicieron nuevas altas/bajas oficiales durante esta verificación. Docker y PostgreSQL servidor deben validarse en el hosting de destino; las pruebas locales no sustituyen el smoke test oficial. Antes de habilitar clientes en PROD, ejecutar en TEST real una alta, consultar `finished`, actualizar, agregar upgrades y cancelar una membership futura; comprobar los registros en Audax, incluida su política de precios y las dos discrepancias de formato señaladas arriba.

## Estructura

```text
src/          API, autenticación, validación, cola y adaptador Audax
public/       Panel web sin dependencias de frontend ni servicios externos
migrations/   Esquema PostgreSQL
tests/        Pruebas funcionales y del adaptador
scripts/      Inicialización y comprobación de sintaxis
docs/         OpenAPI, colección Postman y ambientes vacíos
deploy/       Ejemplo de proxy HTTPS
```

Implementado con Node.js, Fastify y PostgreSQL. Se eligió Fastify para mantener pequeño el servicio, con API y worker independientes dentro del mismo proyecto. Referencias técnicas: [Fastify](https://fastify.dev/docs/latest/Reference/Server/), [transacciones node-postgres](https://node-postgres.com/features/transactions) y [OAuth 2.0 Client Credentials](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.4).


## Dos entornos independientes

El selector **Entorno** abre TEST o PROD. Son dos procesos del mismo programa, con el mismo esquema de tablas y bases físicamente separadas. No se agregan sufijos a las tablas porque el aislamiento se hace por base. Cada proceso posee sus usuarios, sesiones, tokens, credenciales oficiales, catálogos, operaciones y memberships.

- Local TEST: http://127.0.0.1:3000, base `data/test`, URL Audax TEST.
- Local PROD: http://127.0.0.1:3001, base `data/prod`, URL Audax PROD. `LOCAL_PREVIEW=true` crea una vista vacía sin permitir credenciales oficiales ni envíos. No es un despliegue productivo.
- `npm run setup` genera ambos archivos de configuración sin sobrescribirlos. `npm run dev:both` inicia los dos procesos. Las contraseñas de administrador son distintas.
- Despliegue: dos proyectos Compose (`audax-test`, `audax-prod`) con volúmenes PostgreSQL distintos. PROD requiere HTTPS, cookies seguras, clave de cifrado propia y `LOCAL_PREVIEW` desactivado. Configurá `TEST_PORTAL_URL` y `PROD_PORTAL_URL` con los dominios correspondientes.

La guía del panel publica la URL exacta del ambiente actual y los scopes `memberships:read memberships:insert memberships:update memberships:upgrade memberships:cancel`. El usuario debe tener esos permisos; se puede solicitar un subconjunto. Las credenciales de clientes del middleware son distintas de las de Portsoft.

La colección se descarga desde **Guía de integración → Descargar colección Postman**. Se importa como un solo JSON y contiene URL, scope, variables y scripts para guardar token/ProcessID. Completar client_id/client_secret y ajustar el ejemplo de membership a los datos autorizados. Genera una clave de idempotencia al primer envío y la conserva para reintentos; vaciar esa variable para una nueva operación. Los archivos de ambiente TEST/PROD son opcionales.

## Código y extensiones

Ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) para el mapa de módulos, responsabilidades, tablas y puntos de extensión. Los módulos y las funciones principales incluyen comentarios sobre su propósito y las garantías que preservan.
