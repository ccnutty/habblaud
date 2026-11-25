import { randomUUID } from 'node:crypto';
import { MiniAppError } from './bridge-queue.mjs';

export function createPreview() {
  const updatedAt = Date.now();
  const sessions = [
    { id: 'preview-claude', project: 'Demo Workspace', title: 'Review mobile navigation', provider: 'claude', status: 'waiting', updatedAt, canMessage: true },
    { id: 'preview-codex', project: 'Demo Workspace', title: 'Verify sample settings', provider: 'codex', status: 'working', updatedAt, canMessage: true },
    { id: 'preview-habblaud', project: 'Habblaud', title: 'Telegram Mini App', provider: 'codex', status: 'idle', updatedAt, canMessage: true },
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
      if (operation === 'listSessions') return sessions;
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
