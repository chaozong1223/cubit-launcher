// Mock Minecraft LAN server for tunnel PoC.
// Speaks a line protocol: client sends "MCLPING <nonce>\n", server replies
// "MCLPONG <nonce> <pid> <isoTime>\n" and closes. Enough to prove that a TCP
// byte stream survives the tunnel in both directions.
//
// Usage: node echo-server.mjs [bindHost] [port] [logFile]
import net from 'node:net'
import fs from 'node:fs'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 25565)
const logFile = process.argv[4] ?? ''

function log (line) {
  const text = `${new Date().toISOString()} ${line}`
  console.log(text)
  if (logFile) fs.appendFileSync(logFile, text + '\n')
}

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`
  log(`ACCEPT peer=${peer}`)
  socket.setEncoding('utf8')
  socket.setTimeout(10000, () => { log(`TIMEOUT peer=${peer}`); socket.destroy() })
  let buf = ''
  socket.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      log(`RECV peer=${peer} line=${JSON.stringify(line)}`)
      if (line.startsWith('MCLPING ')) {
        const nonce = line.slice('MCLPING '.length).trim()
        const reply = `MCLPONG ${nonce} pid=${process.pid} at=${new Date().toISOString()}\n`
        socket.write(reply)
        log(`SEND peer=${peer} line=${JSON.stringify(reply.trim())}`)
      }
    }
  })
  socket.on('close', () => log(`CLOSE peer=${peer}`))
  socket.on('error', (err) => log(`ERROR peer=${peer} err=${err.message}`))
})

server.on('error', (err) => { log(`LISTEN_ERROR ${err.message}`); process.exitCode = 1 })
server.listen(port, host, () => {
  log(`LISTEN host=${host} port=${port}`)
})
