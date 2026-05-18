import type { Router } from 'express'
import QRCode from 'qrcode'
import { serverUrl } from '../broadcast.js'

export function registerQrRoute(router: Router) {
  router.get('/qr/:id', async (req, res) => {
    const judgeNum = parseInt(req.params.id, 10)
    if (judgeNum < 1 || judgeNum > 4) {
      res.status(400).end()
      return
    }
    const url = `${serverUrl}/judge?id=${judgeNum}`
    try {
      const png = await QRCode.toBuffer(url, {
        width: 200,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      })
      res.set('Content-Type', 'image/png').send(png)
    } catch {
      res.status(500).end()
    }
  })
}
