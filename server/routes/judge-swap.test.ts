// @vitest-environment node
import type { Request, Response, Router } from 'express'
// @ts-expect-error jsdom is installed for tests but this project has no @types/jsdom.
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { registerJudgeRoute } from './judge.js'

it('keeps the red station left and blue station right while displaying swapped names', () => {
  let handler: ((req: Request, res: Response) => void) | undefined
  const router = {
    get: (_path: string, route: (req: Request, res: Response) => void) => { handler = route },
  } as unknown as Router
  registerJudgeRoute(router)
  let html = ''
  handler?.({ query: { id: '1' } } as unknown as Request,
    { send: (body: string) => { html = body } } as unknown as Response)
  expect(html).toContain('id="hdr-red"')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('embedded judge client missing')

  const listeners = new Map<string, (data: unknown) => void>()
  const commands: Array<{ event: string; payload: Record<string, unknown> }> = []
  const socket = {
    on(event: string, callback: (data: unknown) => void) { listeners.set(event, callback) },
    emit(event: string, payload: Record<string, unknown>, reply?: (value: unknown) => void) {
      commands.push({ event, payload })
      if (event === 'judge:connect') reply?.({ judgeId: 'J1' })
    },
  }
  const dom = new JSDOM(html, { url: 'http://localhost/judge?id=1', runScripts: 'outside-only' })
  try {
    Object.assign(dom.window, { io: () => socket })
    dom.window.eval(script)
    listeners.get('connect')?.(undefined)
    const match = {
      id: 'fight', categoryId: 'category', matchMode: 'sparring',
      red: { id: 'a', name: 'Ana' }, blue: { id: 'b', name: 'Beto' },
      preFight: { loadId: 'generation', revision: 0, started: false, timingKind: 'regular' },
    }
    const state = { categoryId: 'category', judges: ['J1'],
      matchState: { phase: 'round', currentRound: 1 }, match }
    listeners.get('state:update')?.(state)
    expect(dom.window.document.querySelector('#hdr-red')?.textContent).toBe('Ana')
    expect(dom.window.document.querySelector('#hdr-blue')?.textContent).toBe('Beto')

    listeners.get('state:update')?.({ ...state, match: {
      ...match, red: match.blue, blue: match.red,
      preFight: { ...match.preFight, revision: 1, swapCount: 1 },
    } })
    const row = dom.window.document.querySelector('.header-row')
    expect(row?.children[0].id).toBe('hdr-red')
    expect(row?.children[0].classList.contains('red')).toBe(true)
    expect(row?.children[2].id).toBe('hdr-blue')
    expect(row?.children[2].classList.contains('blue')).toBe(true)
    expect(row?.children[0].textContent).toBe('Beto')
    expect(row?.children[2].textContent).toBe('Ana')
    expect(dom.window.document.querySelector('#subtitle')?.textContent).toBe('Beto vs Ana')

    dom.window.eval("score('red','pts_1',1)")
    expect(commands.at(-1)).toMatchObject({ event: 'match:event', payload: {
      categoryId: 'category', matchId: 'fight', competitor: 'red',
      expectedLoadId: 'generation', expectedAssignmentRevision: 1,
    } })
  } finally {
    dom.window.close()
  }
})
