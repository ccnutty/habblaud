import { randomUUID } from 'node:crypto';
import { MiniAppError } from './bridge-queue.mjs';

export function createPreview() {
  const updatedAt = Date.now();
  const rooms = [
    { name: 'Demo Workspace', seed: 51048, slot: 0 },
    { name: 'Habblaud', seed: 22410, slot: 1 },
  ];
  const explorer = { id: 'preview-explorer', name: 'Beatriz', title: '验收交易页交互', provider: 'claude',
    badge: 'A', role: 'general-purpose', status: 'working', seed: 17580, look: 'f', activityKind: 'browser' };
  const tester = { id: 'preview-tester', name: 'Heitor', title: '核对示例场景', provider: 'codex',
    role: 'explorer', status: 'shell', seed: 26150, look: 'm', activityKind: 'test' };
  const reviewer = { id: 'preview-reviewer', name: 'Bernardo', title: '检查项目房间状态', provider: 'codex',
    role: 'worker', status: 'working', seed: 74925, look: 'm', activityKind: 'read', activityFile: 'room-model.ts' };
  const sessions = [
    { id: 'preview-claude', project: 'Demo Workspace', name: 'Sofia', title: '移动端交易导航验收', provider: 'claude',
      status: 'waiting', activityKind: 'ask', updatedAt, canMessage: true, subagents: 1, subagentDetails: [explorer],
      seed: 30499, look: 'f' },
    { id: 'preview-codex', project: 'Demo Workspace', name: 'Rafaela', title: '检查示例设置与交互', provider: 'codex',
      status: 'working', activityKind: 'test', updatedAt, canMessage: true, subagents: 1, subagentDetails: [tester],
      seed: 75725, look: 'f' },
    { id: 'preview-habblaud', project: 'Habblaud', name: 'Flávia', title: 'Telegram Mini App', provider: 'codex',
      status: 'working', activityKind: 'edit', updatedAt, canMessage: true, subagents: 1, subagentDetails: [reviewer],
      seed: 88212, look: 'f' },
    { id: 'preview-infra', project: 'Habblaud', name: 'Cecília', title: '网关连接检查', provider: 'claude',
      status: 'idle', statusSince: updatedAt - 32 * 60_000, activityKind: 'done', updatedAt, canMessage: false,
      subagents: 0, seed: 13323, look: 'f' },
  ];
  const activity = [
    { sessionId: 'preview-claude', agent: 'Sofia', kind: 'ask', at: updatedAt - 30_000 },
    { sessionId: 'preview-codex', agent: 'Rafaela', kind: 'test', at: updatedAt - 180_000 },
    { sessionId: 'preview-habblaud', agent: 'Flávia', kind: 'edit', at: updatedAt - 420_000 },
    { sessionId: 'preview-infra', agent: 'Cecília', kind: 'done', at: updatedAt - 1_200_000 },
  ];
  const accounts = [
    { name: 'Codex', provider: 'codex', usageStatus: 'ok', sevenDay: { utilization: 12, resetsAt: updatedAt + 259_200_000 } },
    { name: 'Conta A', provider: 'claude', usageStatus: 'disabled' },
  ];
  const conversations = new Map(sessions.map((session) => [
    session.id, [
      { id: 'first-user', role: 'user', text: '请继续检查当前任务。', at: updatedAt - 120_000 },
      { id: 'first-agent', role: 'assistant', text: '已检查当前分支和验收项。下一步会验证手机端操作。', at: updatedAt - 60_000 },
    ],
  ]));
  const messages = new Map();

  return {
    run(operation, [id, text] = []) {
      if (operation === 'listSessions') return id === 'overview' ? { sessions, rooms, activity, accounts } : sessions;
      if (operation === 'getMessage') {
        if (!messages.has(id)) throw new MiniAppError(404, 'message_expired');
        return messages.get(id);
      }
      const entries = conversations.get(id);
      if (!entries) throw new MiniAppError(404, 'session_unavailable');
      if (operation === 'getConversation') return { entries, truncated: false };

      const message = { id: randomUUID(), agentId: id, status: 'queued', updatedAt: Date.now() };
      messages.set(message.id, message);
      setTimeout(() => {
        entries.push(
          { id: randomUUID(), role: 'user', text, at: Date.now() },
          { id: randomUUID(), role: 'assistant', text: '收到。这是预览里的模拟回复。', at: Date.now() },
        );
        messages.set(message.id, { ...message, status: 'delivered', updatedAt: Date.now() });
      }, 600).unref();
      setTimeout(() => messages.delete(message.id), 600_000).unref();
      return message;
    },
  };
}
