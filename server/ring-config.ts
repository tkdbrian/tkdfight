import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data')
const CONFIG_PATH = path.join(DATA_DIR, 'ring.json')

export interface RingConfig {
  alias: string
  name: string
}

const DEFAULT_CONFIG: RingConfig = { alias: 'T1', name: 'Tatami 1' }

export function getRingConfig(): RingConfig {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<RingConfig>
    return {
      alias: typeof parsed.alias === 'string' ? parsed.alias : DEFAULT_CONFIG.alias,
      name: typeof parsed.name === 'string' ? parsed.name : DEFAULT_CONFIG.name,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function setRingConfig(alias: string, name: string): RingConfig {
  const config: RingConfig = { alias: alias.trim() || 'T1', name: name.trim() || 'Tatami 1' }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  return config
}
