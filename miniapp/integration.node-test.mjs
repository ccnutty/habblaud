import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBridgeQueue } from './bridge-queue.mjs';
import { createGatewayHandler } from './gateway.mjs';
import { createHabblaudClient } from './habblaud-client.mjs';
import { telegramUsersFromEnv, verifyTelegramUser } from './telegram-auth.mjs';

const testToken = '10000:test-fixture-token';
const currentTime = 1_800_000_000;
const authOptions = {
  botToken: testToken,
  allowedUserIds: new Set(['424242']),
  nowSeconds: currentTime,
};

function signedData({ id = 424242, timestamp = currentTime } = {}) {
  const fields = {
    auth_date: String(timestamp),
    query_id: 'webview-test',
    signature: 'test-third-party-signature',
    user: JSON.stringify({ id, first_name: '中文 + test' }),
  };
  const secret = createHmac('sha256', 'WebAppData').update(testToken).digest();
  const canonical = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\n');
  const hash = createHmac('sha256', secret).update(canonical).digest('hex');
  const result = new URLSearchParams(Object.entries(fields).reverse());
  result.set('hash', hash);
  return result.toString();
}

test('accepts an allowed Telegram identity with valid signed data', () => {
  assert.equal(verifyTelegramUser(signedData(), authOptions), '424242');
});

test('reads TG_USER_ID as a fallback while preserving the explicit MINIAPP_USERS list', () => {
  const config = { TG_USER_ID: ' 424242 ' };
  assert.equal(verifyTelegramUser(signedData(), { ...authOptions, allowedUserIds: telegramUsersFromEnv(config) }), '424242');
  assert.deepEqual(telegramUsersFromEnv({ ...config, MINIAPP_USERS: '424243, 424244' }), new Set(['424243', '424244']));
  assert.deepEqual(telegramUsersFromEnv({ ...config, MINIAPP_USERS: '' }), new Set());
});

test('rejects tampered, duplicated and unsigned Telegram fields', () => {
  const valid = signedData();
  assert.equal(verifyTelegramUser(valid.replace('424242', '424243'), authOptions), null);
  assert.equal(verifyTelegramUser(`${valid}&auth_date=${currentTime}`, authOptions), null);
  assert.equal(verifyTelegramUser(valid.split('&hash=')[0], authOptions), null);
});

test('rejects expired and future signatures and unlisted Telegram users', () => {
  for (const input of [
    { timestamp: currentTime - 301 },
    { timestamp: currentTime + 31 },
    { id: 424243 },
  ]) {
    assert.equal(verifyTelegramUser(signedData(input), authOptions), null);
  }
});

const room = { id: '/Users/example/private/project', name: 'project' };
const main = {
  id: '.codex:thread-id', kind: 'main', roomId: room.id, name: 'Nina', title: 'Mobile build',
  provider: 'codex', status: 'working', lastEventAt: 20, canMessage: true,
};

test('presents real main sessions in priority order without project paths or raw activity', async () => {
  const claude = {
    ...main, id: '.claude:111', provider: undefined, title: undefined, name: 'Omar', status: 'waiting',
    activity: { text: 'Workspace command', detail: '/Users/example/private/project' }, canMessage: false,
  };
  const client = createHabblaudClient({ fetchImpl: async (url) => {
    assert.equal(url.href, 'http://127.0.0.1:4747/api/snapshot');
    return Response.json({
      rooms: [room], meta: { messages: true },
      agents: [main, claude, { ...main, kind: 'sub' }, { ...main, id: 'demo:abc' }],
    });
  } });
  assert.deepEqual(await client.listSessions(), [
    { id: claude.id, project: 'project', title: 'Omar', provider: 'claude', status: 'waiting', updatedAt: 20, canMessage: false },
    { id: main.id, project: 'project', title: 'Mobile build', provider: 'codex', status: 'working', updatedAt: 20, canMessage: true },
  ]);
});

test('exposes only the fields needed by the mobile overview', async () => {
  const recent = Array.from({ length: 26 }, (_, at) => ({
    kind: 'edit', at, text: 'raw summary', detail: 'private path',
  }));
  const client = createHabblaudClient({ fetchImpl: async () => Response.json({
    rooms: [{ ...room, seed: 351, slot: 1 }], meta: { messages: true },
    agents: [
      { ...main, recent, seed: 13, look: 'm', account: 'codex',
        activity: { kind: 'read', detail: '/Users/example/private/view.lua' } },
      { ...main, id: 'child', kind: 'sub', name: 'Eva', parentId: main.id, seed: 19, activity: { kind: 'test', at: 50 } },
      { ...main, id: 'nested', kind: 'sub', parentId: 'child' },
      { ...main, id: 'completed', kind: 'sub', parentId: main.id, status: 'done' },
      { ...main, id: 'demo:child', kind: 'sub', parentId: main.id },
    ],
    accounts: [{
      id: 'codex', short: 'X', name: 'Codex', provider: 'codex', email: 'private@example.com', configDir: room.id, usageStatus: 'ok',
      usage: { sevenDay: { utilization: 12, resetsAt: 100 } },
    }],
  }) });
  const overview = await client.listSessions('overview');
  assert.equal(overview.sessions[0].subagents, 2);
  assert.equal(overview.sessions[0].name, 'Nina');
  assert.equal(overview.sessions[0].badge, 'X');
  assert.equal(overview.sessions[0].seed, 13);
  assert.equal(overview.sessions[0].activityFile, 'view.lua');
  assert.deepEqual(overview.sessions[0].subagentDetails.map(({ id }) => id), ['child', 'nested']);
  assert.equal(overview.sessions[0].subagentDetails[0].activityKind, 'test');
  assert.deepEqual(overview.rooms, [{ name: room.name, seed: 351, slot: 1 }]);
  assert.equal(overview.activity.length, 24);
  assert.deepEqual(overview.activity[0], { sessionId: main.id, agent: 'Eva', at: 50, kind: 'test' });
  assert.deepEqual(overview.accounts[0].sevenDay, { utilization: 12, resetsAt: 100 });
  assert.doesNotMatch(JSON.stringify(overview), /private|raw summary/);
});

test('preserves the target and content and reads the delivery status separately', async () => {
  const status = { id: 'm-test-id', agentId: main.id, status: 'queued', updatedAt: 25 };
  const instruction = '请继续下一项\n保留现有配置';
  const client = createHabblaudClient({ fetchImpl: async (url, options) => {
    if (url.pathname === '/api/messages') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.headers, {
        'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4747',
      });
      assert.deepEqual(JSON.parse(options.body), { agentId: main.id, text: instruction });
      return Response.json(status, { status: 201 });
    }
    assert.equal(url.pathname, `/api/messages/${status.id}`);
    assert.equal(options.method, undefined);
    return Response.json({ ...status, status: 'delivered' });
  } });
  assert.deepEqual(await client.sendMessage(main.id, instruction), status);
  assert.deepEqual(await client.getMessage(status.id), { ...status, status: 'delivered' });
});

test('rejects unsafe targets before sending and surfaces upstream rejections', async () => {
  assert.throws(() => createHabblaudClient({ baseUrl: 'http://192.168.1.28:4747' }), /loopback/);
  const client = createHabblaudClient({ fetchImpl: async () => Response.json({ error: 'offline' }, { status: 409 }) });
  await assert.rejects(client.sendMessage('demo:abc', 'hi'), /real Habblaud session/);
  await assert.rejects(client.sendMessage(main.id, ' '), /Message must contain/);
  await assert.rejects(client.getMessage('../snapshot'), /message ID/);
  await assert.rejects(client.sendMessage(main.id, 'hello'), { status: 409 });
});

test('reads only user and assistant text from a chunked Habblaud terminal stream', async () => {
  const init = {
    agentId: main.id, truncated: true,
    entries: [
      { id: 'user', kind: 'user', text: '检查进度', at: 1 },
      { id: 'tool', kind: 'tool', input: 'sensitive command', at: 2 },
      { id: 'assistant', kind: 'assistant', text: '已完成', at: 3 },
    ],
  };
  let cancelled = false;
  const client = createHabblaudClient({ fetchImpl: async (url) => {
    assert.equal(url.pathname, '/api/agents/.codex%3Athread-id/terminal');
    const frame = new TextEncoder().encode(': ping\n\nevent: init\ndata: ' + JSON.stringify(init) + '\n\n');
    return new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < frame.length; i += 3) controller.enqueue(frame.subarray(i, i + 3));
      },
      cancel() { cancelled = true; },
    }));
  } });
  assert.deepEqual(await client.getConversation(main.id), {
    truncated: true,
    entries: [
      { id: 'user', role: 'user', text: '检查进度', at: 1 },
      { id: 'assistant', role: 'assistant', text: '已完成', at: 3 },
    ],
  });
  assert.equal(cancelled, true);
});

test('does not requeue a claimed send when delivery is uncertain', async () => {
  const queue = createBridgeQueue({ timeoutMs: 15 });
  assert.throws(() => queue.run('listSessions'), { status: 503 });
  assert.equal(queue.claim(), null);
  const result = queue.run('sendMessage', [main.id, 'continue']);
  const job = queue.claim();
  assert.equal(job.operation, 'sendMessage');
  assert.equal(queue.claim(), null);
  await assert.rejects(result, { message: 'delivery_unknown', status: 504 });
  assert.equal(queue.claim(), null);
  assert.equal(queue.complete(job.id, { ok: true }), false);
});

async function http(handler, url, { body, token, method = body ? 'POST' : 'GET' } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [], { objectMode: false });
  req.url = url;
  req.method = method;
  req.headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {}),
  };
  const res = {
    headers: {}, status: 200,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(raw) { this.raw = raw?.toString(); },
  };
  await handler(req, res);
  return {
    status: res.status,
    headers: res.headers,
    data: res.headers['Content-Type']?.startsWith('application/json') ? JSON.parse(res.raw) : res.raw,
  };
}

test('gateway checks Telegram and bridge independently and relays messages by session ID', async () => {
  const bridgeSecret = 'fixture-secret-with-more-than-32-characters';
  const gateway = createGatewayHandler({ botToken: testToken, allowedUserIds: authOptions.allowedUserIds, bridgeSecret });
  assert.equal((await http(gateway, '/api/sessions')).status, 401);
  assert.equal((await http(gateway, '/api/overview')).status, 401);
  assert.equal((await http(gateway, '/bridge/jobs/next')).status, 401);
  assert.equal((await http(gateway, '/api/auth', { body: { initData: 'tampered' } })).status, 401);
  const auth = await http(gateway, '/api/auth', { body: { initData: signedData({ timestamp: Math.floor(Date.now() / 1000) }) } });
  assert.equal(auth.status, 200);
  assert.equal((await http(gateway, '/bridge/jobs/next', { token: auth.data.token })).status, 401);
  assert.equal((await http(gateway, '/api/sessions', { token: bridgeSecret })).status, 401);
  assert.equal((await http(gateway, '/api/sessions', { token: auth.data.token })).data.code, 'mac_offline');
  assert.equal((await http(gateway, '/bridge/jobs/next', { token: bridgeSecret })).status, 204);

  const request = http(gateway, '/api/messages', {
    token: auth.data.token, body: { agentId: main.id, text: 'continue' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const { data: job } = await http(gateway, '/bridge/jobs/next', { token: bridgeSecret });
  assert.equal(job.operation, 'sendMessage');
  assert.deepEqual(job.args, [main.id, 'continue']);
  const receipt = { id: 'm-fixture', agentId: main.id, status: 'queued' };
  const result = { ok: true, data: receipt };
  assert.equal((await http(gateway, '/bridge/jobs/' + job.id, { token: bridgeSecret, body: result })).status, 200);
  assert.equal((await http(gateway, '/bridge/jobs/' + job.id, { token: bridgeSecret, body: result })).status, 404);
  assert.equal((await request).status, 201);
  assert.deepEqual((await request).data, receipt);

  const overview = http(gateway, '/api/overview', { token: auth.data.token });
  await new Promise((resolve) => setImmediate(resolve));
  const legacy = (await http(gateway, '/bridge/jobs/next', { token: bridgeSecret })).data;
  assert.equal(legacy.operation, 'listSessions');
  assert.deepEqual(legacy.args, ['overview']);
  await http(gateway, '/bridge/jobs/' + legacy.id, { token: bridgeSecret, body: { ok: true, data: [] } });
  assert.deepEqual((await overview).data, { sessions: [] });
});

test('local preview serves the Mini App and a synthetic send-and-reply loop', async () => {
  const gateway = createGatewayHandler({ preview: true });
  const page = await http(gateway, '/');
  assert.equal(page.status, 200);
  assert.match(page.data, /id="composer"/);
  assert.doesNotMatch(page.data, /telegram-web-app\.js/);
  assert.equal((await http(gateway, '/app.mjs')).status, 200);
  assert.equal((await http(gateway, '/locale.mjs')).status, 200);
  assert.equal((await http(gateway, '/office-art.mjs')).status, 200);
  const art = await http(gateway, '/office.png');
  assert.equal(art.headers['Content-Type'], 'image/png');
  const { data: overview } = await http(gateway, '/api/overview');
  assert.ok(overview.sessions.length && overview.activity.length && overview.accounts.length);
  const { data: [session] } = await http(gateway, '/api/sessions');
  const { data: message } = await http(gateway, '/api/messages', { body: { agentId: session.id, text: '继续' } });
  assert.equal(message.status, 'queued');
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal((await http(gateway, '/api/messages/' + message.id)).data.status, 'delivered');
  const { data: conversation } = await http(gateway, '/api/sessions/' + session.id + '/conversation');
  assert.deepEqual(conversation.entries.slice(-2).map((entry) => entry.role), ['user', 'assistant']);
  assert.equal(conversation.entries.at(-2).text, '继续');
});
