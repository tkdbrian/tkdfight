# TKD Fight 4.0.2

Sistema de mesa para torneos de Taekwondo: Round Robin, eliminación, resultados,
historial y respaldos. React/TypeScript + Vite, servidor Node/Express y SQLite.

## Versión V4

- Combate por banderas y Tul: confirmación durable, corrección de resultados y
  recuperación del estado confirmado por el servidor.
- Ajustes previos al combate y **Postergar** seguro: solo una carga sin iniciar,
  sin actividad; la cola cambia después de la aceptación del servidor.
- Reinicio con la lista actual: **Archivar y reiniciar** conserva la ejecución
  actual; **Eliminar y reiniciar** descarta solo esa ejecución, preservando los
  archivos anteriores. Con participantes insuficientes queda en preparación,
  sin fixture ni ganador; agregar participantes e iniciar explícitamente.
- **Eliminar categoría** visible y separado de Reiniciar, con vista previa y
  confirmación protegida; no borra otras categorías ni archivos anteriores.
- Impresión de categoría con vista previa, detalle opcional y llave clásica;
  exportaciones CSV/HTML y respaldo/restauración completos.
- Persistencia local protegida, recuperación visible y portable de un clic con
  identidad propia por instalación.

[Notas de entrega y evidencia de 4.0.2](docs/RELEASE_V4.0.2.md).

## Usar en un torneo

El repositorio contiene **fuentes**, no una instalación lista para usar. Extraer
el ZIP portable completo y abrir **ABRIR TKD.exe**; no abrir `index.html` mediante
`file://` ni copiar archivos sueltos. Cada PC funciona de forma independiente y
sin Internet en el entorno soportado Windows 10/11 x64, con un navegador
compatible y carpeta escribible. El servidor local permanece activo al cerrar
el navegador. El paquete incluye Node; el requisito VC++ incluido puede pedir
permisos de administrador si falta en esa PC. No se garantiza cualquier equipo.

- [Instrucciones del portable](scripts/release-sunday/template/LEEME_DOMINGO.txt)
- [Construcción y validación del paquete](scripts/release-sunday/README.md)

**Estado de entrega:** las pruebas automáticas no sustituyen la validación del
EXE, icono de bandeja y ZIP exacto en otra PC Windows 10/11 x64 sin Internet.
Esa aceptación manual sigue pendiente; no se considera aprobada por este README.

## Desarrollo

Usar **Node 24 LTS** (`.nvmrc`, CI y runtime del portable), npm y una carpeta propia
para los datos. `npm ci` instala las versiones bloqueadas y `better-sqlite3` para
ese runtime; no reutilizar dependencias nativas de otra versión de Node.

```powershell
npm ci

# Terminal 1: API local, no utilizar los datos de una instalación real.
$env:PORT = '3399'
$env:DATA_DIR = Join-Path $env:TEMP ('tkd-fight-dev-' + [guid]::NewGuid())
npm run server

# Terminal 2: interfaz; comprobar antes que ambos puertos estén libres.
$env:API_PORT = '3399'
npm run dev -- --host 127.0.0.1 --port 5199 --strictPort
```

Sin estas variables Vite usa el puerto 5173 y deriva API/socket al puerto 3001.
No ejecutar pruebas operativas contra los puertos o datos del torneo real; no
detener procesos ajenos para liberar un puerto.

## Verificaciones

```powershell
npx vitest run src server --maxWorkers=2
npx tsc --project tsconfig.json --noEmit
npx tsc --project tsconfig.server.json --noEmit
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-sunday/Test-OneClick.ps1

# Build de verificación aislado: no reemplaza dist/ ni una instalación activa.
$stage = Join-Path $env:TEMP ('tkd-build-' + [guid]::NewGuid())
node node_modules/vite/bin/vite.js build --outDir "$stage/dist"
npm exec -- esbuild server/index.ts --bundle --platform=node --packages=external --format=esm "--outfile=$stage/dist-server/index.mjs"
```

Playwright requiere los navegadores y el entorno indicado por cada configuración;
el modo E2E general no debe apuntarse a una instalación real. Los ensayos del
portable se realizan sobre copias vacías aisladas, según la guía de construcción.

Flujos dirigidos verificados para V4 (ejecutar **uno por vez**, comparten puertos):

```powershell
npx playwright test --config playwright.category-buttons.config.ts --grep "draft restart"
npx playwright test --config playwright.fight-buttons.config.ts
npx playwright test --config playwright.utility-buttons.config.ts
```

Categorías usa API 3317/Vite 5174; combate y utilidades API 3397/Vite 5197.
Cada prueba crea una base temporal y termina únicamente su propio servidor.
El filtro de categorías corresponde a los 10 casos de reinicio de esta entrega;
la configuración también contiene otras pruebas de navegación y edición.
La suite E2E general y las pruebas físicas no se consideran aprobadas por estos
tres comandos. La instalación de navegadores de Playwright es una preparación
de desarrollo, no un requisito del portable.

## Fuentes y archivos generados

- `src/`, `server/`, `public/`: aplicación, API y recursos.
- `scripts/release-sunday/`: único empaquetador mantenido y supervisor de un clic.
- `scripts/check-runtime.cjs`, `scripts/Ensure-VCRedist.ps1`: diagnóstico del runtime.
- `scripts/descargar-vcredist.ps1`: preparación del requisito firmado para publicar.
- `e2e/` y pruebas junto al código: regresiones y flujos funcionales.

Dependencias, builds, ZIP/EXE generados, bases de datos, perfiles, secretos y
registros locales no se versionan. El portable incluye su propio Node y las
dependencias de ejecución; el equipo de torneo no necesita instalar Node ni un IDE.

Los lanzadores BAT, instalador y guías antiguos se retiraron del seguimiento Git;
su historial sigue disponible en commits anteriores. Las copias locales y las
instalaciones existentes no se borraron ni se migraron por esta limpieza. Los
cambios de este repositorio no actualizan automáticamente una instalación o demo.
