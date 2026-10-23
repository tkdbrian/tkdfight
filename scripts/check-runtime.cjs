const requiredModules = [
  'better-sqlite3',
  'express',
  'express-rate-limit',
  'helmet',
  'pino',
  'qrcode',
  'socket.io',
  'zod',
]

try {
  for (const moduleName of requiredModules) {
    require(moduleName)
  }

  const Database = require('better-sqlite3')
  const database = new Database(':memory:')
  database.prepare('SELECT 1').get()
  database.close()
  console.log('RUNTIME_OK')
} catch (error) {
  console.error(error.stack || error.message)
  process.exitCode = 1
}