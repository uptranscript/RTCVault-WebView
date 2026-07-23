// RTCVault 音声ストリーミング用 Service Worker。
//
// 音声の実体は持たない。`__rtcv_audio__` への fetch（<audio> が出す Range
// リクエスト）を横取りし、ページ（DataChannel を持つ RtcClient）へ範囲取得を
// 委譲して 206 Partial Content を返す。これにより <audio> がネイティブに
// 総時間の把握・任意時刻へのシーク・バッファ管理を行える。

const pending = new Map() // requestId -> resolve関数
let seq = 0

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// ページからの範囲取得結果を受け取る。
self.addEventListener('message', (event) => {
  const d = event.data
  if (!d || d.type !== 'rtcv-range-result') {
    return
  }
  const resolve = pending.get(d.requestId)
  if (resolve) {
    pending.delete(d.requestId)
    resolve(d)
  }
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // base 配下の任意位置でも拾えるよう endsWith で判定。それ以外は素通し。
  if (!url.pathname.endsWith('/__rtcv_audio__')) {
    return
  }
  const id = url.searchParams.get('id')
  event.respondWith(handleRange(event, id))
})

async function handleRange(event, id) {
  // Range ヘッダを解析（無ければ先頭から）。
  let start = 0
  let end = -1
  const range = event.request.headers.get('Range')
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    if (m) {
      start = parseInt(m[1], 10)
      end = m[2] ? parseInt(m[2], 10) : -1
    }
  }

  const client =
    (await self.clients.get(event.clientId)) || (await self.clients.matchAll())[0]
  if (!client) {
    return new Response('no client', { status: 503 })
  }

  const requestId = id + ':' + seq++
  const result = await new Promise((resolve) => {
    pending.set(requestId, resolve)
    client.postMessage({ type: 'rtcv-range-request', requestId, id, start, end })
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId)
        resolve({ error: 'timeout' })
      }
    }, 30000)
  })

  if (result.error) {
    return new Response(result.error, { status: 502 })
  }

  const buf = result.bytes // ArrayBuffer（転送済み）
  const total = result.totalSize
  const mime = result.mime || 'audio/mpeg'
  const last = start + buf.byteLength - 1

  // Range が無い最初の要求でも、Accept-Ranges を返しつつ 206 で部分応答する
  // ことで、ブラウザに「シーク可能なストリーム」と認識させる。
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(buf.byteLength),
    'Content-Range': 'bytes ' + start + '-' + last + '/' + total,
    'Cache-Control': 'no-store',
  }
  return new Response(buf, { status: 206, headers })
}
