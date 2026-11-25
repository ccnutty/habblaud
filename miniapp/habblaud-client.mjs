const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_MESSAGE_LENGTH = 20_000;
const MESSAGE_STATUSES = new Set(['queued', 'sent', 'delivered', 'failed']);
const STATUS_ORDER = ['waiting', 'working', 'shell', 'idle', 'done', 'offline'];
const DEMO_PREFIX = 'demo:';

/** The Mac bridge calls the existing Habblaud listener without exporting its API. */
export function createHabblaudClient({
  baseUrl = 'http://127.0.0.1:4747',
  fetchImpl = fetch,
} = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !LOCAL_HOSTS.has(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Habblaud must use a loopback HTTP origin');
  }

  async function request(path, body, { stream = false } = {}) {
    const options = { redirect: 'error', signal: AbortSignal.timeout(5000) };
    if (body !== undefined) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json', Origin: base.origin };
      options.body = JSON.stringify(body);
    }
    const response = await fetchImpl(new URL(path, base), options);
    if (!response.ok) {
      const error = new Error(`Habblaud returned HTTP ${response.status}`);
      error.status = response.status;
      if (stream) await response.body?.cancel();
      throw error;
    }
    return stream ? response.body : response.json();
  }

  return {
    async listSessions(view) {
      const snapshot = await request('/api/snapshot');
      const names = new Map(snapshot.rooms.map((room) => [room.id, room.name]));
      const agents = snapshot.agents.filter((agent) => !agent.id.startsWith(DEMO_PREFIX));
      const main = agents.filter((agent) => agent.kind === 'main');
      const sessions = main
        .map((agent) => ({
          id: agent.id,
          project: names.get(agent.roomId) ?? '',
          title: agent.title || agent.name,
          provider: agent.provider ?? 'claude',
          status: agent.status,
          updatedAt: agent.lastEventAt,
          canMessage: snapshot.meta.messages === true && agent.canMessage === true,
        }))
        .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          b.updatedAt - a.updatedAt);
      return view === 'overview' ?
        officeOverview(sessions, agents, snapshot.rooms, snapshot.accounts ?? []) : sessions;
    },

    async getConversation(agentId) {
      validateAgentId(agentId);
      const stream = await request('/api/agents/' + encodeURIComponent(agentId) + '/terminal', undefined, { stream: true });
      const init = await readTerminalInit(stream);
      if (init.agentId !== agentId) throw new Error('Unexpected Habblaud session');
      const messages = init.entries.filter(({ kind, text }) =>
        (kind === 'user' || kind === 'assistant') && typeof text === 'string' && text.trim());
      return {
        truncated: init.truncated || messages.length > 12,
        entries: messages.slice(-12).map(({ id, kind, text, at }) => ({
          id, role: kind, text: text.slice(0, 3000), at,
        })),
      };
    },

    async sendMessage(agentId, text) {
      validateAgentId(agentId);
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_LENGTH) {
        throw new Error('Message must contain between 1 and 20,000 characters');
      }
      return messageStatus(await request('/api/messages', { agentId, text }));
    },

    async getMessage(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error('A Habblaud message ID is required');
      }
      return messageStatus(await request(`/api/messages/${id}`));
    },
  };
}

function officeOverview(sessions, agents, rooms, accounts) {
  const mainIds = new Set(sessions.map(({ id }) => id));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const subagents = new Map();
  const owners = new Map(sessions.map(({ id }) => [id, id]));
  for (const agent of agents) {
    if (agent.kind !== 'sub') continue;
    const visited = new Set([agent.id]);
    let parent = agent.parentId;
    while (parent && !mainIds.has(parent) && !visited.has(parent)) {
      visited.add(parent);
      parent = agentById.get(parent)?.parentId;
    }
    if (!mainIds.has(parent)) continue;
    owners.set(agent.id, parent);
    if (['offline', 'done'].includes(agent.status)) continue;
    const group = subagents.get(parent) ?? [];
    group.push({ id: agent.id, ...agentCard(agent, accountById) });
    subagents.set(parent, group);
  }
  const activity = agents.flatMap((agent) => {
    const sessionId = owners.get(agent.id);
    if (!sessionId) return [];
    const recent = agent.recent?.length ? agent.recent : [agent.activity];
    return recent.filter((event) => Number.isFinite(event?.at)).map(({ at, kind }) => ({
      sessionId, agent: agent.name, at, kind,
    }));
  }).sort((a, b) => b.at - a.at).slice(0, 24);
  return {
    sessions: sessions.map((session) => {
      const children = subagents.get(session.id) ?? [];
      return {
        ...session, ...agentCard(agentById.get(session.id), accountById),
        subagents: children.length, subagentDetails: children,
      };
    }),
    rooms: rooms.filter(({ seed }) => Number.isInteger(seed)).map(({ name, seed, slot }) => ({ name, seed, slot })),
    activity,
    accounts: accounts.map(({ name, provider = 'claude', usage, usageStatus }) => ({
      name, provider, usageStatus,
      fiveHour: usageWindow(usage?.fiveHour),
      sevenDay: usageWindow(usage?.sevenDay),
      noQuota: usage?.noQuota === true,
    })),
  };
}

function agentCard(agent, accounts) {
  const activity = agent.activity;
  const file = ['read', 'edit', 'write'].includes(activity?.kind) && typeof activity.detail === 'string' ?
    activity.detail.split(/[\\/]/).at(-1) : '';
  return {
    name: agent.name, title: agent.title || agent.name, provider: agent.provider ?? 'claude',
    status: agent.status, statusSince: agent.statusSince, activityKind: activity?.kind,
    activityFile: /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,56}\.[a-z\d]{1,12}$/iu.test(file) ? file : undefined,
    badge: accounts.get(agent.account)?.short,
    seed: agent.seed, look: agent.look, parts: agent.parts,
    ...(agent.kind === 'sub' ? { role: agent.role } : {}),
  };
}

function usageWindow(window) {
  if (!Number.isFinite(window?.utilization)) return undefined;
  return { utilization: window.utilization, resetsAt: window.resetsAt };
}

function validateAgentId(id) {
  if (typeof id !== 'string' || !id || id.length > 256 ||
      /[\/\x00-\x1f\x7f]/.test(id) || id === '.' || id === '..' || id.startsWith(DEMO_PREFIX)) {
    throw new Error('A real Habblaud session ID is required');
  }
}

async function readTerminalInit(stream) {
  if (!stream) throw new Error('Habblaud terminal stream is empty');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Habblaud terminal stream ended before init');
      bytes += value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('Habblaud terminal init is too large');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index).split(/\r?\n/);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (!frame.includes('event: init')) continue;
        return JSON.parse(frame.filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, '')).join('\n'));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function messageStatus({ id, agentId, status, updatedAt }) {
  if (!MESSAGE_STATUSES.has(status)) throw new Error('Unrecognized Habblaud message status');
  return { id, agentId, status, updatedAt };
}
