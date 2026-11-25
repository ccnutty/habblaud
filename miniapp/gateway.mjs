import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBridgeQueue, MiniAppError } from './bridge-queue.mjs';
import { telegramUsersFromEnv, verifyTelegramUser } from './telegram-auth.mjs';
import { createPreview } from './preview.mjs';
import { tr } from '../shared/locales/telegram.mjs';

const MAX_JSON_BYTES = 512 * 1024;
const SESSION_SECONDS = 8 * 60 * 60;
const assets = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['web/app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['web/style.css', 'text/css; charset=utf-8']],
  ['/locale.mjs', ['../shared/locales/telegram.mjs', 'text/javascript; charset=utf-8']],
]);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new MiniAppError(415, 'invalid_request');
  }
  if (Number(req.headers['content-length']) > MAX_JSON_BYTES) throw new MiniAppError(413, 'invalid_request');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      req.resume();
      throw new MiniAppError(413, 'invalid_request');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object');
    return body;
  } catch {
    throw new MiniAppError(400, 'invalid_request');
  }
}

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
}

function compare(a, b) {
  const digest = (text) => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function createGatewayHandler({ preview = false, botToken, allowedUserIds, bridgeSecret, jobs } = {}) {
  if (!preview && (!botToken || !allowedUserIds?.size || !bridgeSecret || bridgeSecret.length < 32)) {
    throw new Error('MINIAPP_BOT_TOKEN (TG_BOT_API_TOKEN), MINIAPP_USERS (TG_USER_ID), MINIAPP_BRIDGE_SECRET');
  }
  const bridge = jobs ?? (preview ? createPreview() : createBridgeQueue());
  const sessionKey = randomBytes(32);
  const sign = (payload) => createHmac('sha256', sessionKey).update(payload).digest('base64url');
  const now = () => Math.floor(Date.now() / 1000);
  const authorize = (req) => {
    const [id, expires, proof, ...extra] = bearer(req).split('.');
    return extra.length === 0 && allowedUserIds.has(id) && /^\d+$/.test(expires ?? '') &&
      Number(expires) > now() && typeof proof === 'string' && compare(proof, sign(id + '.' + expires));
  };

  return async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");

    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      const method = req.method;
      if (method === 'GET' && assets.has(path)) {
        const [file, mime] = assets.get(path);
        let data = await readFile(new URL(file, import.meta.url));
        if (preview && path === '/') {
          data = data.toString().replace('<script defer src="https://telegram.org/js/telegram-web-app.js"></script>', '');
        }
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
        return;
      }
      if (method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });

      if (path === '/api/auth' && method === 'POST') {
        if (preview) return json(res, 200, { preview: true });
        const { initData } = await readJson(req);
        const id = verifyTelegramUser(initData, { botToken, allowedUserIds });
        if (!id) throw new MiniAppError(401, 'not_authorized');
        const payload = id + '.' + (now() + SESSION_SECONDS);
        return json(res, 200, { token: payload + '.' + sign(payload), preview: false });
      }

      if (!preview && path.startsWith('/bridge/')) {
        if (!compare(bearer(req), bridgeSecret)) throw new MiniAppError(401, 'not_authorized');
        if (method === 'GET' && path === '/bridge/jobs/next') {
          const job = bridge.claim();
          if (job) return json(res, 200, job);
          res.writeHead(204);
          res.end();
          return;
        }
        const result = /^\/bridge\/jobs\/([a-f0-9-]{36})$/.exec(path);
        if (method === 'POST' && result) {
          const accepted = bridge.complete(result[1], await readJson(req));
          return json(res, accepted ? 200 : 404, { accepted });
        }
      }

      if (path.startsWith('/api/')) {
        if (!preview && !authorize(req)) throw new MiniAppError(401, 'not_authorized');
        if (method === 'GET' && path === '/api/sessions') {
          return json(res, 200, await bridge.run('listSessions'));
        }
        const conversation = /^\/api\/sessions\/([^/]+)\/conversation$/.exec(path);
        if (method === 'GET' && conversation) {
          return json(res, 200, await bridge.run('getConversation', [decodeURIComponent(conversation[1])]));
        }
        if (method === 'POST' && path === '/api/messages') {
          const { agentId, text } = await readJson(req);
          if (typeof agentId !== 'string' || !agentId || agentId.length > 256 ||
              typeof text !== 'string' || !text.trim() || text.length > 20_000) {
            throw new MiniAppError(400, 'invalid_request');
          }
          return json(res, 201, await bridge.run('sendMessage', [agentId, text]));
        }
        const message = /^\/api\/messages\/([A-Za-z0-9_-]+)$/.exec(path);
        if (method === 'GET' && message) {
          return json(res, 200, await bridge.run('getMessage', [message[1]]));
        }
      }
      throw new MiniAppError(404, 'not_found');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof MiniAppError) return json(res, error.status, { code: error.message });
      return json(res, 500, { code: 'unavailable' });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = process.argv.includes('--preview');
  if (!preview && process.env.MINIAPP_ENV_FILE) process.loadEnvFile(process.env.MINIAPP_ENV_FILE);
  const host = preview ? '127.0.0.1' : process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 4849);
  const handler = createGatewayHandler({
    preview, botToken: process.env.MINIAPP_BOT_TOKEN ?? process.env.TG_BOT_API_TOKEN,
    allowedUserIds: telegramUsersFromEnv(process.env),
    bridgeSecret: process.env.MINIAPP_BRIDGE_SECRET,
  });
  createServer(handler).listen(port, host, () => console.log(tr('Mini App em {0}', ['http://' + host + ':' + port])));
}
