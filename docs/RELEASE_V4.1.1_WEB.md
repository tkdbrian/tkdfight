# TKD Fight 4.1.1 — panel de combate móvil (web)

## Alcance

- En pantallas móviles, la cabecera y la navegación del combate ya no se cortan;
  la categoría activa se muestra completa sin repetirse y los controles táctiles
  principales tienen áreas de al menos 44 px.
- **Iniciar combate** queda visible antes de los ajustes opcionales, que se pueden
  desplegar. El marcador conserva rojo a la izquierda y azul a la derecha.
- Los cuatro jueces se muestran en filas legibles, con un solo desplazamiento
  vertical. El menú de acciones secundarias y el diálogo de pelea huésped
  conservan el foco accesible.
- No cambian la puntuación, la validación para iniciar, las reglas deportivas,
  los datos persistidos ni las API. El diseño de escritorio se conserva.

## Verificación aislada

- `npm run build:web` correcto; suite completa: **1.126 pruebas aprobadas,
  2 omitidas**.
- Navegador móvil a 320, 390 y 430 px: sin desplazamiento horizontal ni errores
  JavaScript; **Iniciar** visible antes de la barra inferior, botones de jueces
  de 44 px, categoría larga legible y rojo/azul en sus lados habituales.
- Revisión básica de escritorio a 1366 px sin desbordamiento.

## Entrega y datos

Esta revisión es **web**. No se creó ni modificó un ZIP portable 4.1.1; el ZIP
4.1.0 y las instalaciones locales permanecen independientes. El despliegue en
Render Free puede perder su base temporal, por lo que se debe comprobar su
estado y contar con autorización explícita para descartar los datos de prueba
antes de publicarlo.
