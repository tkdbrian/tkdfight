// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

let directory: string | null = null
let database: typeof import('./index.js') | null = null

afterEach(() => {
  database?.default.close()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = null
  database = null
  vi.unstubAllEnvs()
  vi.resetModules()
})

it('excludes swap receipts from backups and clears old retries on restore', async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'tkd-swap-backup-'))
  vi.stubEnv('DATA_DIR', directory)
  vi.resetModules()
  database = await import('./index.js')
  const backup = await import('./full-backup.js')
  const swap = await import('./match-swap.js')
  const request = {
    requestId: 'before-restore', categoryId: 'category', matchId: 'fight',
    expectedRevision: 0, expectedLoadId: 'old-load',
    expectedRedId: 'red', expectedBlueId: 'blue',
  }
  database.default.prepare('INSERT INTO match_swap_receipts (request_id, fingerprint) VALUES (?, ?)')
    .run(request.requestId, JSON.stringify([
      request.categoryId, request.matchId, request.expectedRevision, request.expectedLoadId,
      request.expectedRedId, request.expectedBlueId,
    ]))
  expect(swap.hasSwapReceipt(request)).toBe(true)
  const snapshot = backup.captureSqlBackup()
  expect(Object.keys(snapshot.tables)).not.toContain('match_swap_receipts')
  backup.restoreSqlBackup(snapshot, 'backup-id', 'payload-hash', 'browser-hash')
  expect(swap.hasSwapReceipt(request)).toBe(false)
  expect(() => swap.swapNeverStartedMatch(request)).toThrow('stale_match_context')
})
