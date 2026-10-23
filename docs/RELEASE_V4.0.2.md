# TKD Fight V4.0.2 — entrega y mantenimiento

## Identificación de la entrega

- Versión de aplicación: **4.0.2**.
- Build: `20261023-15d597b47e-221853`.
- ZIP de distribución: `TKD_Fight_V4_TORNEO.zip` (62.279.523 bytes).
- SHA-256: `d10a8a521e323f96c8f3e5eae0b4715ab5463cf246a8dbb402d40a7f028a1c41`.
- Fingerprint de los 270 inputs de build:
  `15d597b47e28e17aed509d22077c82608003c66ab3d860c403e0598782925081`.

El ZIP es un artefacto separado: **no se versiona en Git**. Contiene un único
paquete con `ABRIR TKD.exe` en la raíz, `LEEME_DOMINGO.txt`,
`release-manifest.json`, `Prerequisites/` y `sistema/`. El manifiesto verifica
2.813 archivos de payload; incluye 169 paquetes de ejecución y datos de los
cuatro roles inicialmente vacíos. Las notas y pruebas E2E de publicación no
forman parte del cálculo de fingerprint; no cambian el bundle entregado.

## Cambios principales

V4 incorpora impresión con vista previa, configuración previa al combate,
confirmaciones durables de Tul, recuperación y protección de persistencia local.

La revisión 4.0.1 permite reiniciar aunque se hayan retirado competidores de la
lista actual, sin confundir esa lista con los participantes históricos.
**Archivar y reiniciar** conserva la ejecución actual; **Eliminar y reiniciar**
descarta solamente esa ejecución y preserva los archivos anteriores.
La revisión **4.0.2** agrega:

- Reinicio de eliminación con 0/1 participantes o Round Robin con 0/1/2 como
  borrador en preparación: sin generar encuentros, BYE ni ganador automático.
  Se conserva la configuración; la ejecución original se archiva o elimina
  según el modo elegido, sin borrar archivos anteriores. Iniciar exige
  completar la lista y una acción explícita.
- Postergar una carga sin iniciar libera su bloqueo de forma durable, con
  identidad de carga, revisión y recibo idempotente. Una repetición no libera
  un combate posterior; resultados y encuentros no se borran.
- Guardar nombre de tatami comprueba HTTP y respuesta aceptada; errores o falta
  de conexión no muestran un falso «Guardado» y la edición se bloquea mientras
  hay una solicitud pendiente.
- CSV escapa comillas, comas y saltos de línea sin alterar los datos originales.
- Eliminar categoría se muestra directamente como acción secundaria destructiva,
  separada de Reiniciar y con las mismas protecciones de confirmación.

## Evidencia registrada para esta entrega

- Vitest: **119 archivos / 1.004 tests PASS** (`src` y `server`).
- TypeScript cliente y servidor: PASS; builds aislados y sellado: PASS.
- Navegador aislado: 10 escenarios de reinicio, 4 de combate y 1 de utilidades
  (descargas CSV/HTML reales, vista previa, detalle/volver y eliminar/cancelar).
- QA independiente del ZIP exacto: hashes y tamaños de los 2.813 archivos,
  identidad/build, datos vacíos, 10 casos HTTP de reinicio con Node incluido y
  9 comprobaciones de Postergar sobre el servidor empaquetado: PASS.

Esto **no** equivale a probar todos los botones, todos los E2E o todo hardware.
Continúan pendientes la aceptación del EXE/bandeja en otra PC Windows 10/11 x64
sin Internet y la impresión física. Los jueces remotos y la agregación LAN no
forman parte de la aceptación del evento de PCs independientes.

## Publicación y actualización segura

Publicar fuentes y tag no instala la versión en equipos existentes. No copiar
archivos nuevos sobre una instalación con datos ni migrar bases manualmente.
Preservar el ZIP anterior y su checksum antes de reemplazar la copia de entrega;
las extracciones, procesos y datos existentes deben permanecer intactos.

Para construir otra entrega, congelar fuentes, usar un stage temporal nuevo,
medir fingerprint antes/después y seguir
[el empaquetador mantenido](../scripts/release-sunday/README.md). No reutilizar
el build ID de este documento para bytes diferentes.

La publicación de V4 debe hacerse en una rama de release y tag explícitos, sin
actualizar `main` ni activar un despliegue de demostración por accidente. El
workflow del repositorio ejecuta tests/build en `release/**`; servicios externos
pueden tener sus propias reglas y deben comprobarse antes de cualquier despliegue.
