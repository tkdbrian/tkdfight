# Demo web local: compilación de staging

La mesa individual bajo `/demo/` es **opt-in** y todavía no reemplaza la entrada pública. Para preparar una compilación web aislada:

```powershell
$env:TKD_BROWSER_DEMO_BUILD = '1'
npm run build:web
node scripts/verify-demo-offline.mjs dist demo
node scripts/verify-demo-fresh-offline.mjs dist
Remove-Item Env:TKD_BROWSER_DEMO_BUILD
```

Sin `TKD_BROWSER_DEMO_BUILD=1`, `npm run build:web` conserva el manifest, registro y worker existentes de `/` (incluido el caché de API). El modo opt-in emite `/demo-sw.js` con alcance `/demo/`, `/demo.webmanifest` y un worker puente para `/`; no debe activarse en `render.yaml` ni publicarse sin la aceptación y autorización de datos correspondientes.

En perfiles con el worker antiguo de la web 4.1.1, abrir primero `/tv/demo` para instalar el worker de alcance limitado: el viejo worker puede servir HTML obsoleto si se entra directamente en `/demo/`. La demo muestra «lista para uso sin conexión» solo tras comprobar el worker y los archivos actuales. Si el navegador deniega el registro o falla el caché, la mesa sigue disponible online y ofrece **Reintentar descarga sin conexión**. Safari/PWA en iPhone requiere una prueba real antes de prometer uso offline; el navegador integrado de WhatsApp no lo garantiza.

Esta compilación no cambia el ZIP portable, no sincroniza datos entre dispositivos y no migra ni borra automáticamente datos existentes.

## Prueba pública sin tocar la web actual

**No desplegar esta rama en el servicio `tkdfight` existente para probarla.** Ese
servicio es Node/Render Free y su SQLite está en `DATA_DIR` local: cualquier
redespliegue o reinicio puede perder los datos de la web actual, aunque `/`
continúe mostrando la mesa anterior. `render.yaml` sigue describiendo solo ese
servicio; no agregar allí `TKD_BROWSER_DEMO_BUILD` para la prueba.

Cuando el código esté revisado y publicado en una rama de prueba, crear en
Render Dashboard **New → Static Site** como servicio *nuevo*, con un nombre y
subdominio distintos de `tkdfight.onrender.com`. Antes de publicar esa rama,
comprobar en Dashboard que el servicio Node existente sigue otra rama o tiene
Auto-Deploy desactivado; un push a su rama conectada también podría desplegarlo.

| Ajuste del sitio nuevo | Valor |
| --- | --- |
| Repositorio / rama | Este repositorio / rama aprobada de la demo |
| Build Command | `npm ci && TKD_BROWSER_DEMO_BUILD=1 npm run build:web` |
| Publish Directory | `dist` |
| Redirects/Rewrites | Acción **Rewrite**, Source `/demo/*`, Destination `/index.html` |

Abrir **`https://<subdominio-nuevo>.onrender.com/demo/`**, no la raíz `/`:
esta compilación mantiene la mesa anterior en `/`, que requiere servidor y no
puede funcionar en un sitio puramente estático. **No depender de un Redirect
`/` → `/demo/` en el Dashboard**: Render no aplica reglas de redirección a
recursos que ya existen, y `index.html` ocupa la raíz; además su documentación
sobre reglas para la raíz es ambigua. Compartir siempre el enlace `/demo/` y
verificarlo antes de invitar a probar. La regla de reescritura permite
abrir o recargar `/demo/` directamente; los archivos reales (`/demo-sw.js`,
assets y manifest) se sirven sin reescribir. No configurar proxy de `/api`,
`/boot-status` ni Socket.IO: la demo no los necesita. El sitio nuevo tiene otro
origen, por lo que sus datos IndexedDB no se mezclan con los de la web actual.
Tampoco necesita `/tv/demo`, pensado únicamente para rescatar navegadores que
ya tienen el worker antiguo en **el mismo** dominio `tkdfight.onrender.com`.

Verificar en un iPhone real: entrar desde Safari a la URL `/demo/`, esperar
«Lista para uso sin conexión», añadirla a la pantalla de inicio si se desea,
activar modo avión, recargar y terminar una pelea. Probar también exportar e
importar un respaldo, dos pestañas del mismo perfil y dos navegadores separados.
La prueba en una URL nueva **no** comprueba por sí sola la migración del worker
antiguo del dominio público; antes de sustituir `/` habrá que probar la ruta
`/tv/demo` allí. Los datos de la URL de prueba no pasarán automáticamente al
dominio definitivo: exportar/importar si se quieren conservar.

Los Static Sites son [gratuitos de desplegar](https://render.com/docs/static-sites),
pero consumen las cuotas incluidas de build y ancho de banda. Antes de un
despliegue futuro en el servicio existente, consultar de nuevo su estado y pedir
autorización expresa para la posible pérdida de **todos** sus datos SQL; una
autorización anterior sobre otros datos de prueba no alcanza. Comprobar también
el ajuste **Auto-Deploy** en Dashboard: `render.yaml` no lo fija y Render
conserva el valor ya configurado para un servicio existente.
