# Mapa del programa

## Flujo de una membership

1. API pública o formulario manual recibe los datos. Autenticación y permisos son obligatorios, sin una confirmación manual adicional.
2. `operations.enqueue` valida exclusivamente los datos y pares business/plan de ese pedido y guarda lote e items en una transacción. Una clave idempotente evita duplicados ante reintentos.
3. `worker` reclama una operación con lease y la envía mediante `audax`. Conserva el ProcessID oficial devuelto por Audax.
4. El mismo worker consulta GetProcessStatus con prioridad sobre nuevas altas y sincronizaciones de catálogos. No repite la configuración de conexión ni descarga catálogos para seguir un proceso recibido.
5. Al obtener finished/failed, guarda estado, respuesta e información de error. Solo finished actualiza la proyección local `memberships`.
6. El panel refresca automáticamente Resumen, Operaciones, detalle y actividad de memberships. Esto no reenvía datos a Audax.

Un timeout de escritura puede haber ocurrido después de que Audax recibiera los datos. Por eso queda unknown, sin reintento ciego. La conciliación excepcional sigue existiendo; el flujo normal no requiere intervención.

## Dónde cambiar cada cosa

| Archivo | Responsabilidad |
|---|---|
| `src/config.mjs` | Variables de entorno, URLs oficiales, restricciones de PROD y selector de portales. |
| `src/db.mjs` | PostgreSQL/PGlite, transacciones y migraciones bajo lock. |
| `src/services.mjs` | Construcción e inyección de servicios por ambiente. |
| `src/security.mjs` | Hashes, tokens, sesión, CSRF, bootstrap y auditoría. |
| `src/settings.mjs` | Cifrado de credenciales oficiales, prueba de conexión, identidad y revisión concurrente. |
| `src/catalogs.mjs` | Sincronización atómica y relaciones GetPlans agrupadas por business. |
| `src/validation.mjs` | Contrato y permisos compartidos por API y carga manual. |
| `src/operations.mjs` | Recepción persistente, idempotencia y representación pública del proceso. |
| `src/audax.mjs` | Token Microsoft, HTTP oficial, endpoints, límites y errores remotos. |
| `src/worker.mjs` | Cola SQL, leases, recuperación, envío, seguimiento y proyección confirmada. |
| `src/app.mjs` | Rutas OAuth/API, sesiones, ABM, operaciones, documentación y archivos del panel. |
| `src/admin-routes.mjs` | Rutas administrativas de conexión, catálogos, carga y actividad. |
| `src/main.mjs` | Arranque API con worker opcional y cierre ordenado. |
| `src/worker-main.mjs` | Worker separado para PostgreSQL. |
| `public/app.js` | Navegación, usuarios, operaciones, refresco y guía. |
| `public/audax-modules.js` | Formularios de conexión/memberships y catálogos en ambos ambientes. |
| `scripts/generate-api-docs.mjs` | Fuente de OpenAPI, colección y ambientes Postman; regenerar tras cambiar el contrato. |
| `scripts/run-local.mjs` | Supervisor de los dos procesos locales. |

## Tablas y aislamiento

Las bases TEST/PROD tienen el mismo esquema. `environment_lock` impide abrir una base de otro ambiente; cada instancia aplica las mismas migraciones numeradas.

- `admins`, `admin_sessions`: acceso al panel.
- `clients`, `access_tokens`: integraciones externas, permisos y tokens revocables.
- `audax_settings`: credenciales oficiales cifradas y estado de conexión.
- `catalog_entries`, `business_plan_links`, `catalog_sync_runs`: catálogos, relaciones oficiales y trabajos de sincronización.
- `operations`, `operation_items`: cola durable, payloads e idempotencia.
- `delivery_attempts`: respuestas de envío/consulta.
- `memberships`: última solicitud confirmada por Audax, no una copia de todo su sistema.
- `audit_events`, `worker_health`: trazabilidad y salud.
- `mock_processes`: solo pruebas/simulador. Las operaciones mock nunca se envían con el worker real.

## Cómo extenderlo

Para un nuevo endpoint: ampliar `validation`, registrar la recepción en `app`, agregar el mapping en `audax` y su procesamiento en `worker`. Conservar atomicidad, idempotencia y clasificación de resultados inciertos. Agregar pruebas y regenerar OpenAPI/Postman.

Para un cambio de esquema: agregar una migración numerada y registrarla en `db`. No modificar migraciones aplicadas ni copiar la base TEST a PROD.

Para escalar: usar PostgreSQL, API y workers separados con la misma configuración y clave por ambiente. SKIP LOCKED y leases coordinan múltiples workers. Antes de multiplicar APIs, centralizar rate limits en el proxy o almacenamiento compartido. No usar PGlite con múltiples procesos apuntando al mismo directorio.

Las descargas administrativas usan una lista fija de documentos permitidos. Nunca servir `.env`, claves de cifrado, bases o secretos. Los ejemplos de Postman no contienen credenciales.
