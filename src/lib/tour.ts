import { driver } from 'driver.js'
import type { DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'

// ── Tipos ─────────────────────────────────────────────────────────────────────
interface TourStep {
  route: string
  selector?: string
  title: string
  description: string
}

type NavigateFn = (to: string) => void

// ── Registro global de steps (orden = flujo real del torneo) ──────────────────
const GLOBAL_STEPS: TourStep[] = [
  // 1. Reglas
  {
    route: '/settings',
    selector: '#tour-settings-presets',
    title: '① Presets de reglas',
    description: 'Empezá acá. Copa Danes 26 incluida — un clic aplica jueces, rounds y duración.',
  },
  {
    route: '/settings',
    selector: '#tour-settings-tabs',
    title: '② Configuración detallada',
    description: 'General · Final y desempate · Cuadrilátero. Configurá ANTES de cargar competidores.',
  },
  // 2. Competidores
  {
    route: '/',
    selector: '#tour-cat-btn',
    title: '③ Configurar categoría',
    description: 'Peso, grado, género y formato (Round Robin o Eliminación directa).',
  },
  {
    route: '/',
    selector: '#tour-competitor-card',
    title: '④ Agregar competidores',
    description: 'Nombre + club, luego Enter. También podés importar desde Excel o TXT.',
  },
  {
    route: '/',
    selector: '#tour-start-btn',
    title: '⑤ Iniciar categoría',
    description: 'Con ≥ 3 competidores aparece el botón verde "Iniciar Categoría". Las peleas se generan solas.',
  },
  // 3. Combate
  {
    route: '/fight',
    selector: '#tour-fight-header',
    title: '⑥ Combate activo',
    description: 'Rojo vs Azul. Usá las flechas ← → para navegar entre peleas.',
  },
  {
    route: '/fight',
    selector: '#tour-timer',
    title: '⑦ Cronómetro',
    description: '"Cargar combate" activa el cronómetro. PLAY arranca. ±15 s cuando está pausado.',
  },
  {
    route: '/fight',
    selector: '#tour-bottom-tabs',
    title: '⑧ Banderas de jueces',
    description: 'Mesa decide · Por juez (botón individual) · Remotos (celular vía QR).',
  },
  // 4. Clasificación
  {
    route: '/standings',
    title: '⑨ Clasificación en vivo',
    description: 'Victoria = 3 pts · Empate = 1 · Derrota = 0. Se actualiza con cada resultado.',
  },
  {
    route: '/standings',
    title: '⑩ Desempate automático',
    description: 'El sistema detecta empates y genera la pelea extra. Criterios: más banderas a favor → menos en contra → menos advertencias.',
  },
  // 5. Historial
  {
    route: '/history',
    title: '⑪ Historial permanente',
    description: 'Todas las categorías completadas, guardadas aunque reiniciés el torneo. Funciona offline.',
  },
]

const TOTAL = GLOBAL_STEPS.length

// ── Persistencia ──────────────────────────────────────────────────────────────
const TOUR_KEY = 'tkd-guided-tour'

function saveTourState(stepIndex: number) {
  localStorage.setItem(TOUR_KEY, JSON.stringify({ stepIndex }))
}

function loadTourState(): { stepIndex: number } | null {
  try { return JSON.parse(localStorage.getItem(TOUR_KEY) ?? 'null') } catch { return null }
}

function clearTourState() {
  localStorage.removeItem(TOUR_KEY)
}

// ── Motor de segmentos ────────────────────────────────────────────────────────
function startSegment(navigate: NavigateFn, fromIndex: number) {
  if (fromIndex >= GLOBAL_STEPS.length) { clearTourState(); return }

  const currentRoute = GLOBAL_STEPS[fromIndex].route

  // Colectar steps contiguos de la misma ruta
  let end = fromIndex
  while (end < GLOBAL_STEPS.length && GLOBAL_STEPS[end].route === currentRoute) end++

  const segmentSteps = GLOBAL_STEPS.slice(fromIndex, end)
  const nextStart = end
  const hasNext = nextStart < GLOBAL_STEPS.length

  // Flag para distinguir navegación intencional vs cierre manual (X / ESC)
  let navigating = false

  // d se asigna después de armar los steps; las closures lo capturan por referencia
  let d!: ReturnType<typeof driver>

  const steps: DriveStep[] = segmentSteps.map((s, i) => {
    const globalIdx = fromIndex + i
    const isLast = i === segmentSteps.length - 1
    const title = `${s.title} <span style="font-weight:400;opacity:.6;font-size:.8em">${globalIdx + 1}/${TOTAL}</span>`

    const popover: DriveStep['popover'] = {
      title,
      description: s.description,
    }

    // Cada paso guarda su posición global para poder reanudar con precisión
    if (isLast) {
      // Último paso del segmento: navega a la siguiente ruta (o finaliza)
      if (hasNext) popover.nextBtnText = 'Siguiente página →'
      popover.onNextClick = () => {
        navigating = true
        if (hasNext) {
          saveTourState(nextStart)
          d.destroy()
          navigate(GLOBAL_STEPS[nextStart].route)
        } else {
          clearTourState()
          d.destroy()
        }
      }
    } else {
      // Steps intermedios: guardan índice del SIGUIENTE step y avanzan con driver
      popover.onNextClick = () => {
        saveTourState(globalIdx + 1)
        d.moveNext()
      }
    }

    if (s.selector && document.querySelector(s.selector)) {
      return { element: s.selector, popover }
    }
    return { popover }
  })

  d = driver({
    animate: true,
    showButtons: ['next', 'previous', 'close'],
    nextBtnText: 'Siguiente →',
    prevBtnText: '← Anterior',
    doneBtnText: 'Listo ✓',
    overlayOpacity: 0.65,
    stagePadding: 6,
    popoverClass: 'tkd-tour-popover',
    steps,

    // Si el usuario cierra manualmente (X / ESC), limpiamos estado
    onDestroyStarted: () => {
      if (!navigating) clearTourState()
      d.destroy()
    },
  })

  d.drive()
}

// ── API pública ───────────────────────────────────────────────────────────────

/** Inicia el tour desde el primer step de la ruta actual (o desde settings si no hay match). */
export function startGlobalTour(navigate: NavigateFn, pathname: string): void {
  clearTourState()
  const idx = GLOBAL_STEPS.findIndex((s) => s.route === pathname)
  if (idx >= 0) {
    startSegment(navigate, idx)
  } else {
    // Navegar al primer step del tour
    saveTourState(0)
    navigate(GLOBAL_STEPS[0].route)
  }
}

/** Llamar en cada cambio de ruta. Si hay un tour pendiente para esta ruta, lo retoma. */
export function continueTourIfPending(navigate: NavigateFn, pathname: string): void {
  const state = loadTourState()
  if (!state) return
  const { stepIndex } = state
  if (stepIndex >= GLOBAL_STEPS.length) { clearTourState(); return }
  if (GLOBAL_STEPS[stepIndex].route !== pathname) return

  // Esperar que el DOM de la nueva página termine de montar
  setTimeout(() => {
    const current = loadTourState()
    if (current?.stepIndex !== stepIndex) return
    if (GLOBAL_STEPS[stepIndex].route !== pathname) return
    startSegment(navigate, stepIndex)
  }, 400)
}
