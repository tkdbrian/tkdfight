import pino from 'pino'

// En modo portable/dev → pino-pretty (legible por humanos, colores, timestamps).
// En producción (Render) → JSON estructurado (fácil de filtrar en logs del dashboard).

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  },
  isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      })
    : undefined,
)
