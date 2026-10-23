import { describe, expect, it } from 'vitest'
import { isMiniRoundRobinBout } from './round-robin-playoff'
import type { FightEntry } from '@/store/tournament'

const a = { id: 'a', name: 'A', team: '' }
const b = { id: 'b', name: 'B', team: '' }
const c = { id: 'c', name: 'C', team: '' }
const fight = (id: string, red: typeof a, blue: typeof a, extra: Partial<FightEntry> = {}): FightEntry =>
  ({ id, red, blue, completed: false, groupId: 'G1', ...extra })

describe('mini Round Robin playoff detection', () => {
  it('allows individual draws for explicit and legacy 3-way mini playoffs', () => {
    const bouts = [fight('ab', a, b, { isTiebreakExtra: true }), fight('ac', a, c, { isTiebreakExtra: true }), fight('bc', b, c, { isTiebreakExtra: true })]
    expect(isMiniRoundRobinBout(bouts[0], bouts)).toBe(true)
    expect(isMiniRoundRobinBout({ ...bouts[0], playoffKind: 'mini' }, bouts)).toBe(true)
  })
  it('requires a winner for direct two-person playoff and its Golden Point', () => {
    const direct = fight('ab', a, b, { isTiebreakExtra: true, playoffKind: 'direct' })
    expect(isMiniRoundRobinBout(direct, [direct])).toBe(false)
    expect(isMiniRoundRobinBout({ ...direct, id: 'gp', isTiebreakExtra: false, isGoldenPointFight: true }, [direct])).toBe(false)
  })
  it('allows draws in a legacy three-winner FINAL round robin', () => {
    const bouts = [fight('ab', a, b, { groupId: 'FINAL', isFinalFight: true }), fight('ac', a, c, { groupId: 'FINAL', isFinalFight: true }), fight('bc', b, c, { groupId: 'FINAL', isFinalFight: true })]
    expect(isMiniRoundRobinBout(bouts[0], bouts)).toBe(true)
  })
})
