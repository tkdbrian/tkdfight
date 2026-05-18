export type Mode = 'sparring' | 'patterns'
export type Competitor = 'red' | 'blue'

export interface RuleSetSparring {
  mode: 'sparring'
  judgesCount: number
  rounds: {
    count: number
    duration_seconds: number
    rest_seconds: number
    golden_point?: boolean
    overtime_seconds?: number
  }
  points: Record<string, number>
  deductions: Record<string, number | 'DQ'>
  fouls_for_dq?: number        // default 3
  judgingMode?: 'flags' | 'points'  // default 'flags'
  tiebreak_order?: string[]
  validation?: {
    min_interval_ms_same_judge?: number
    require_majority_for_point?: boolean
  }
}
export interface RuleSetPatterns {
  mode: 'patterns'
  judgesCount: number
  scoringScale: { min: number; max: number; step: number }
  criteria: { key: string; label?: string; weight: number }[]
  drop_high_low?: boolean
  decision: 'highestTotal' | 'flags'
  tie?: string[]
}
export type RuleSet = RuleSetSparring | RuleSetPatterns

// ── Match state machine ────────────────────────────────────────────────────

export type MatchPhase =
  | 'idle'
  | 'round'
  | 'rest'
  | 'overtime'
  | 'golden_point'
  | 'penalties'
  | 'finished'

export type WinReason =
  | 'points'
  | 'dq'
  | 'jury'
  | 'golden_point'
  | 'overtime_points'

export interface MatchResult {
  winner: Competitor | 'draw'
  reason: WinReason
}

export interface MatchEvent {
  id: string
  ts: number
  judgeId: string
  competitor: Competitor
  type: string
  value: number      // numeric delta applied to score (negative for deductions)
  isDQ?: boolean
}

export interface RoundTotals {
  red: number
  blue: number
}

export interface RoundState {
  number: number          // 1-based
  totals: RoundTotals
  deductions: RoundTotals // negative sum of deductions per competitor
  fouls: RoundTotals      // raw foul count per competitor
  events: MatchEvent[]
}

export interface MatchState {
  phase: MatchPhase
  currentRound: number    // 1-based; in overtime/golden_point stays at last round number
  timeLeft: number        // seconds
  rounds: RoundState[]
  firstPoint: Competitor | null   // who scored first overall (for tiebreak)
  result: MatchResult | null
  pendingJuryDecision: boolean
}
