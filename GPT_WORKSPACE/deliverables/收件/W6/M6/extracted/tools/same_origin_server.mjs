/**
 * same_origin_server.mjs —— 同源本地入口（演示脚手架，不属于仓库产品代码）
 *
 * 按 docs/ARCHITECTURE.md §10 的部署拓扑：同一 origin 下
 *   - 静态资源来自 frontend/
 *   - /api/* 与 /health 反向代理到 Actix（默认 127.0.0.1:18080）
 * 代理时补 X-Real-IP，供后端按客户端 IP 限流使用。
 *
 * 用法：node same_origin_server.mjs [listenPort] [actixBase]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const LISTEN_PORT = Number(process.argv[2] ?? 18081);
const ACTIX = process.argv[3] ?? 'http://127.0.0.1:18080';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'work', 'frontend');

/** 故障注入开关：为 true 时，下一次 PUT 在转发成功后被客户端侧丢包 */
let dropNextPut = false;


const MIME = {  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function proxy(req, res) {
  const target = new URL(req.url, ACTIX);
  const headers = { ...req.headers, host: target.host, 'x-real-ip': req.socket.remoteAddress ?? '' };
  const init = { method: req.method, headers };
  const bodyless = req.method === 'GET' || req.method === 'HEAD';
  const upstream = await fetch(target, bodyless ? init : { ...init, body: await readBody(req), duplex: 'half' });
  const outHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (!['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(key)) {
      outHeaders[key] = value;
    }
  });
  const buffer = Buffer.from(await upstream.arrayBuffer());

  // 故障注入：T07「保存响应丢失」——上游已提交成功，但把响应在客户端侧丢掉。
  if (dropNextPut && req.method === 'PUT') {
    dropNextPut = false;
    console.log(`[fault] dropped response of ${req.method} ${req.url} (upstream ${upstream.status})`);
    res.destroy();
    return;
  }

  outHeaders['content-length'] = String(buffer.length);
  res.writeHead(upstream.status, outHeaders);
  res.end(buffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${LISTEN_PORT}`);
    if (url.pathname === '/__fault/drop-next-put') {
      dropNextPut = true;
      sendJson(res, 200, { dropNextPut: true });
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      await proxy(req, res);
      return;
    }

    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const file = join(ROOT, rel === '' ? 'index.html' : rel);
    if (!file.startsWith(ROOT)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    await stat(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch (err) {
    if (req.url.startsWith('/api/') || req.url === '/health') {
      sendJson(res, 502, { error: 'proxy_failed', message: String(err?.message ?? err) });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  }
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`same-origin entry on http://127.0.0.1:${LISTEN_PORT} -> ${ACTIX}`);
});

