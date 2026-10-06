// The review page's server: serves index.html, hands the page the view the
// mod last posted, and queues what the person did there for the mod to take.
// It knows nothing of the draft; the mod does. Started by the mod, it lives
// as long as the mod's load does.
//
//   node server.mjs <token> [port]
//
// Prints one line, `{"ready":<port>}`, once listening, then `{"poke":true}`
// each time the page queues an action, so the mod drains at once.

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const [token, wanted] = process.argv.slice(2)
if (!token) {
  process.stderr.write('usage: node server.mjs <token> [port]\n')
  process.exit(2)
}

const PAGE = new URL('./index.html', import.meta.url)
// The page's actions the mod has not taken yet; bounded so a page left open does not grow it.
const MAX_QUEUED = 200
const ACTIONS = new Set(['open', 'openDoc', 'delete', 'reply', 'archive', 'trash', 'collapse', 'undoRound', 'redoRound', 'acceptRound', 'acceptHunk', 'revert', 'undo', 'redo', 'review', 'cancel'])

let view = { version: 0 }
let queue = []

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, await readFile(PAGE, 'utf8'), 'text/html; charset=utf-8')
    }
    // Every other route takes the token in a header: a page of another origin
    // cannot set one without a preflight this server never answers.
    if (req.headers['x-cotext-token'] !== token) return send(res, 403, 'forbidden')

    if (req.method === 'GET' && url.pathname === '/state') return json(res, view)
    if (req.method === 'POST' && url.pathname === '/view') {
      view = JSON.parse(await body(req))
      return json(res, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/actions') {
      const taken = queue
      queue = []
      return json(res, taken)
    }
    if (req.method === 'POST' && url.pathname === '/action') {
      const action = JSON.parse(await body(req))
      if (!ACTIONS.has(action?.kind)) return send(res, 400, 'unknown action')
      queue.push(action)
      if (queue.length > MAX_QUEUED) queue.shift()
      process.stdout.write('{"poke":true}\n')
      return json(res, { ok: true })
    }
    return send(res, 404, 'not found')
  } catch (error) {
    return send(res, 400, String(error instanceof Error ? error.message : error))
  }
})

function body(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      text += chunk
      if (text.length > 20_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}

function send(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(text)
}

function json(res, value) {
  send(res, 200, JSON.stringify(value), 'application/json')
}

function listen(port) {
  server.once('error', error => {
    // The port the last load used is taken: any free one will do.
    if (port !== 0 && error.code === 'EADDRINUSE') return listen(0)
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ ready: server.address().port })}\n`)
  })
}

listen(Number(wanted) || 0)
