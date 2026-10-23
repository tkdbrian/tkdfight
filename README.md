# TKD Fight 3.0

Sistema de mesa para torneos de Taekwondo: Round Robin, eliminación, resultados,
historial y respaldos. React/TypeScript + Vite, servidor Node/Express y SQLite.

## Usar en un torneo

El repositorio contiene **fuentes**, no una instalación lista para usar. Extraer
el ZIP portable completo y abrir **ABRIR TKD.exe**; no abrir `index.html` mediante
`file://` ni copiar archivos sueltos. Cada PC funciona de forma independiente y
sin Internet. El servidor local permanece activo al cerrar el navegador.

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
$env:PORT = '3001'
$env:DATA_DIR = Join-Path $env:TEMP 'tkd-fight-dev'
npm run server

# Terminal 2: interfaz (Vite indica la dirección disponible).
npm run dev
```

Vite usa `localhost:5173` y deriva API/socket al puerto 3001; si se cambia la API,
establecer `API_PORT` en la terminal de Vite. No ejecutar pruebas operativas contra
los puertos o datos del torneo real.

## Verificaciones

```powershell
npx vitest run --maxWorkers 2
npx tsc --project tsconfig.json --noEmit
npx tsc --project tsconfig.server.json --noEmit
npm run build:prod
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-sunday/Test-OneClick.ps1
```

Playwright requiere los navegadores y el entorno indicado por cada configuración;
el modo E2E general no debe apuntarse a una instalación real. Los ensayos del
portable se realizan sobre copias vacías aisladas, según la guía de construcción.

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
