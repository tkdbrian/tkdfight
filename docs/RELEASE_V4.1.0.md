# TKD Fight 4.1.0 — ZIP portable preparado

## Identidad de la entrega

- Versión de la aplicación: **4.1.0**.
- ZIP entregado por separado en el Escritorio: `TKD_Fight_4.1.0-20261026-089ae4dc8b-231416.zip`. La copia canónica local está en `release/`; los binarios no se incluyen en este repositorio ni se enlazan desde GitHub.
- Build ID: `20261026-089ae4dc8b-231416`.
- Huella SHA-256 del código fuente: `089ae4dc8b1a5fae0a841a5b884e604ba4f90e4cd759aa831a50b54af42f95fe`.
- Tamaño del ZIP: **62.290.124 bytes**.
- SHA-256 del ZIP: `1088e4450bc936b5ea3a7f8fa8280a22b3c4b935dd82722887799a302921acf6` (también en el archivo `.zip.sha256`).

La entrega 4.0.2, sus ZIP y sus checksums se conservan intactos. **Solo se creó
un ZIP nuevo; no se actualizó ni instaló ninguna copia en uso.**

## Mejoras incluidas

- En lucha, la mesa puede **intercambiar los competidores** antes de iniciar y
  sin actividad registrada. El rojo permanece a la izquierda y el azul a la
  derecha; se cambian las identidades, no los paneles ni los controles. El
  inicio queda bloqueado mientras el cambio no esté confirmado. No altera la
  clasificación ni los combates históricos.
- La creación de categorías tiene un **editor guiado** con opciones grandes,
  respuestas editables y acceso más claro a competidores e inicio. La vista de
  competidores y la vista previa de la llave son más legibles.
- En Round Robin, las categorías nuevas de 6 a 12 pueden intercalar grupos
  para favorecer el descanso en un tatami; el calendario regular de cinco no
  cambia. Antes de cargar una pelea que repite un competidor del último
  resultado confirmado, la mesa recibe una sugerencia de alternativa si la hay.
  La sugerencia no reordena la lista guardada.
- Incluye correcciones del flujo de demo e inicio protegido comprobadas en
  pruebas aisladas; no se usaron datos del torneo real para verificarlas.

## Verificación del paquete exacto

- Vitest completo: **1.119/1.119** pruebas.
- TypeScript cliente y servidor: sin errores.
- Lanzador portable `Test-OneClick.ps1`: **38** comprobaciones.
- E2E de categorías con datos aislados: **21/21**; E2E de interfaz de entrega:
  **2/2**; pruebas de empaquetador y versión: **13/13**.
- Build de producción, empaquetado y verificación de huellas del manifiesto:
  correctos.
- ZIP extraído e inspeccionado: **2.813 archivos**, sin bases de datos, datos
  de torneo ni respaldos incluidos. El runtime empaquetado pasó su comprobación.
- Servidor del paquete en entorno aislado: `/boot-status` informó un estado
  vacío y el Build ID esperado. Navegador: versión visible `BL System v4.1.0`
  y recorrido guiado **Edad → Grado** comprobados.

**Pendiente:** aceptación manual del ZIP exacto, sin conexión, en la PC Windows
10/11 x64 de destino, incluidos ejecutable, icono de bandeja y flujo operativo.
Por eso el paquete **no se declara instalado ni aprobado para un torneo**.

## Instalación y conservación de datos

Este ZIP es para una **instalación nueva y separada**. No contiene los datos de
ninguna instalación anterior y **no es una migración in situ**: no copiar sus
archivos sobre un portable que ya tenga categorías o resultados. Conservar el
portable previo y su respaldo. Cualquier restauración debe ensayarse antes en
una copia aislada. Seguir las [instrucciones del portable](../scripts/release-sunday/template/LEEME_DOMINGO.txt)
y el [procedimiento de entrega](../scripts/release-sunday/README.md).
