# Verificación · 24 de septiembre de 2026

- Sintaxis JavaScript verificada.
- **38 pruebas automatizadas aprobadas**: autenticación, ABM, aislamiento, catálogo agrupado, validación, idempotencia, cuatro operaciones, seguimiento, errores, migraciones y descargas.
- Recorrido del navegador con datos aislados: alta y actualización manual en un solo paso, estados que aparecen sin pulsar Actualizar, guía y descarga Postman. Sin escrituras reales en Audax durante estas pruebas.
- Navegador sobre la instalación local: selector TEST/PROD, URLs de guía, descarga JSON, base PROD sin clientes/operaciones/credenciales y formulario de PROD local bloqueado para envíos.
- Consulta real autorizada a Audax TEST para `23132831-5de5-4f67-9080-54a8b5e64394`: HTTP 200, `status: finished`, `errors: null`. Operación local `666afef9-35cc-492e-81b2-4b55edeb85df`: finished. Se consultó el proceso, no se reenvió el alta.

TEST corre en http://127.0.0.1:3000 con su base existente. PROD local corre en http://127.0.0.1:3001 con base independiente y vacía. La vista local PROD no es un despliegue productivo: los envíos requieren PostgreSQL, HTTPS y sus propias credenciales oficiales. No se ejecutaron Docker ni PostgreSQL servidor en este equipo.


## Actualización WMC + WMMS · 30 de septiembre de 2026

- Logos originales en public/assets; altura óptica uniforme mediante CSS, sin deformación. Verificado en escritorio y móvil.
- Recorrido completo de configuración, catálogo por business, usuarios, alta y modificación manual con resultado automático y descarga Postman. Se usaron datos aislados de prueba.
- 38 pruebas funcionales aprobadas en la nueva carpeta del repositorio.
- Exclusiones de Git verificadas: no se publican archivos .env, claves, bases ni node_modules.
- Docker corregido para incluir documentos descargables. CI, configuración HTTPS y guía de despliegue agregadas.
- Docker no está instalado en este equipo: no se ejecutó una construcción de contenedor ni se realizó un despliegue público. La CI contiene ese paso para ejecutarlo en GitHub.
