import { setTimeout as delay } from 'node:timers/promises';
import { createHabblaudClient } from './habblaud-client.mjs';

const operations = new Set(['listSessions', 'getConversation', 'sendMessage', 'getMessage']);
const gateway = new URL(process.env.MINIAPP_GATEWAY_URL ?? 'http://127.0.0.1:4849');
const secret = process.env.MINIAPP_BRIDGE_SECRET;
if (!secret || secret.length < 32) throw new Error('MINIAPP_BRIDGE_SECRET');
if (gateway.protocol !== 'https:' &&
    !(gateway.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname))) {
  throw new Error('MINIAPP_GATEWAY_URL: HTTPS');
}
if (gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash) {
  throw new Error('MINIAPP_GATEWAY_URL');
}

const local = createHabblaudClient({ baseUrl: process.env.HABBLAUD_LOCAL_URL });

async function relay(path, result) {
  return fetch(new URL(path, gateway), {
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    method: result === undefined ? 'GET' : 'POST',
    body: result === undefined ? undefined : JSON.stringify(result),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
}

for (;;) {
  try {
    const response = await relay('/bridge/jobs/next');
    if (response.status === 401) throw new Error('MINIAPP_BRIDGE_SECRET');
    if (response.status === 204) {
      await delay(650);
      continue;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const job = await response.json();
    if (typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id)) continue;
    let result;
    try {
      if (!operations.has(job.operation) || !Array.isArray(job.args)) throw new Error('operation');
      result = { ok: true, data: await local[job.operation](...job.args) };
    } catch (error) {
      result = { ok: false, status: error.status ?? 502 };
    }
    // Losing the receipt does not requeue or resend the operation.
    await relay('/bridge/jobs/' + job.id, result);
  } catch (error) {
    if (error.message === 'MINIAPP_BRIDGE_SECRET') throw error;
    await delay(1500);
  }
}
