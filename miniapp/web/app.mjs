import { tr } from '/locale.mjs';

const $ = (id) => document.getElementById(id);
const names = { codex: 'Codex', claude: 'Claude Code' };
const statuses = {
  waiting: 'Precisa de você', working: 'Trabalhando', shell: 'Comando em execução',
  idle: 'Disponível', done: 'Concluído', offline: 'Desconectado',
};
const deliveries = {
  queued: 'Na fila', sent: 'Entregando', delivered: 'Entregue à sessão',
  failed: 'Falha na entrega',
  delivery_unknown: 'Entrega não confirmada. Confira a conversa antes de reenviar.',
};
const tg = window.Telegram?.WebApp;
const sessionsEl = $('sessions');
const instruction = $('instruction');
const send = $('send');
const drafts = new Map();
const receipts = new Map();
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
let token;
let sessions = [];
let selected;
let sending = false;
let sessionSignature;
let conversationSignature;
let refreshTimer;
let refreshing = false;

if (tg?.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;
document.documentElement.lang = navigator.language;
for (const item of document.querySelectorAll('[data-i18n]')) item.textContent = tr(item.dataset.i18n);
instruction.placeholder = tr('Escreva uma instrução');
instruction.setAttribute('aria-label', instruction.placeholder);
sessionsEl.textContent = tr('Carregando sessões…');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

async function api(path, data) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/' + path, {
    method: data ? 'POST' : 'GET',
    headers,
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.code ?? 'unavailable');
  return result;
}

function showConnection(message = '') {
  $('connection').textContent = message;
  $('connection').hidden = !message;
}

function renderSessions() {
  const signature = JSON.stringify(sessions);
  if (signature === sessionSignature) return;
  sessionSignature = signature;
  sessionsEl.replaceChildren();
  if (!sessions.length) {
    sessionsEl.append(element('p', 'empty', tr('Nenhuma sessão ativa.')));
    return;
  }
  const projects = new Map();
  for (const session of sessions) {
    const project = session.project || tr('Sem projeto');
    if (!projects.has(project)) projects.set(project, []);
    projects.get(project).push(session);
  }
  for (const [project, items] of projects) {
    const group = element('section', 'project');
    group.append(element('h2', 'project-title', project));
    for (const session of items) {
      const row = element('button', 'session');
      row.type = 'button';
      const provider = names[session.provider] ?? session.provider;
      const icon = element('span', 'provider-mark', session.provider === 'codex' ? 'Cx' : 'Cl');
      icon.dataset.provider = session.provider;
      icon.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'session-copy');
      copy.append(element('strong', '', session.title), element('small', '', provider));
      const status = element('span', 'status', tr(statuses[session.status] ?? 'Desconectado'));
      status.dataset.status = session.status;
      row.append(icon, copy, status);
      row.onclick = () => openSession(session.id);
      group.append(row);
    }
    sessionsEl.append(group);
  }
}

function refreshComposer() {
  const session = sessions.find(({ id }) => id === selected);
  const receipt = receipts.get(selected);
  const locked = !session?.canMessage;
  instruction.disabled = locked;
  send.disabled = locked || sending || !instruction.value.trim();
  const label = receipt ? tr(deliveries[receipt.status] ?? deliveries.failed) :
    locked ? tr('Esta sessão está sem canal de mensagens.') : '';
  $('delivery').textContent = label;
  $('delivery').hidden = !label;
}

function openSession(id) {
  const session = sessions.find((item) => item.id === id);
  if (!session) return;
  if (selected) drafts.set(selected, instruction.value);
  selected = id;
  $('office').hidden = true;
  $('detail').hidden = false;
  $('detail-title').textContent = session.title;
  $('detail-meta').textContent = (names[session.provider] ?? session.provider) + ' · ' + tr(statuses[session.status]);
  instruction.value = drafts.get(id) ?? '';
  $('conversation').replaceChildren();
  conversationSignature = undefined;
  tg?.BackButton?.show();
  refreshComposer();
  window.scrollTo(0, 0);
  schedule(0);
}

function closeSession() {
  if (selected) drafts.set(selected, instruction.value);
  selected = undefined;
  $('detail').hidden = true;
  $('office').hidden = false;
  tg?.BackButton?.hide();
  window.scrollTo(0, 0);
}

function renderConversation(conversation) {
  const signature = JSON.stringify(conversation);
  if (signature === conversationSignature) return;
  const wasNearBottom = document.documentElement.scrollHeight <= window.scrollY + window.innerHeight + 100;
  const follow = conversationSignature === undefined || wasNearBottom;
  conversationSignature = signature;
  const feed = $('conversation');
  feed.replaceChildren();
  if (conversation.truncated) feed.append(element('p', 'empty', tr('Mostrando as mensagens mais recentes.')));
  if (!conversation.entries.length) feed.append(element('p', 'empty', tr('Nenhuma mensagem recente.')));
  for (const entry of conversation.entries) {
    const bubble = element('article', 'bubble');
    bubble.dataset.role = entry.role;
    const byline = element('div', 'byline', entry.role === 'user' ? tr('Você') :
      names[sessions.find(({ id }) => id === selected)?.provider] ?? 'Habblaud');
    if (Number.isFinite(entry.at)) byline.append(element('time', '', clock.format(entry.at)));
    bubble.append(byline, element('p', '', entry.text));
    feed.append(bubble);
  }
  if (follow) window.scrollTo(0, document.documentElement.scrollHeight);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    sessions = await api('sessions');
    showConnection();
    renderSessions();
    const id = selected;
    if (!id) return;
    const item = sessions.find((session) => session.id === id);
    if (!item) {
      $('detail-meta').textContent = tr('A sessão não está disponível.');
      refreshComposer();
      return;
    }
    $('detail-meta').textContent = (names[item.provider] ?? item.provider) + ' · ' + tr(statuses[item.status]);
    refreshComposer();
    try {
      const conversation = await api('sessions/' + encodeURIComponent(id) + '/conversation');
      if (id === selected) renderConversation(conversation);
    } catch {
      if (id === selected && conversationSignature === undefined) {
        $('conversation').textContent = tr('Não foi possível carregar as mensagens.');
      }
    }
    if (id !== selected) return;
    const receipt = receipts.get(id);
    if (receipt?.id && ['queued', 'sent'].includes(receipt.status)) {
      try {
        const status = await api('messages/' + receipt.id);
        if (receipts.get(id) === receipt) receipts.set(id, status);
      } catch (error) {
        if (['upstream_rejected', 'message_expired'].includes(error.message) && receipts.get(id) === receipt) {
          receipts.set(id, { status: 'delivery_unknown' });
        }
      }
      if (id === selected) refreshComposer();
    }
  } catch (error) {
    showConnection(tr(error.message === 'mac_offline' ? 'O Mac está desconectado.' :
      error.message === 'not_authorized' ? 'Abra o Mini App pelo Telegram com a conta autorizada.' :
        'Não foi possível atualizar.'));
  } finally {
    refreshing = false;
    schedule(selected ? 3500 : 5500);
  }
}

function schedule(delay) {
  clearTimeout(refreshTimer);
  if (!document.hidden) refreshTimer = setTimeout(refresh, delay);
}

$('back').onclick = closeSession;
tg?.BackButton?.onClick(closeSession);
instruction.oninput = refreshComposer;
$('composer').onsubmit = async (event) => {
  event.preventDefault();
  if (send.disabled || !selected) return;
  const id = selected;
  const text = instruction.value;
  sending = true;
  receipts.set(id, { status: 'sent' });
  refreshComposer();
  try {
    receipts.set(id, await api('messages', { agentId: id, text }));
    if (selected === id && instruction.value === text) instruction.value = '';
    if (drafts.get(id) === text) drafts.delete(id);
  } catch (error) {
    const rejected = ['invalid_request', 'upstream_rejected', 'mac_offline', 'bridge_busy', 'bridge_timeout', 'not_authorized'];
    receipts.set(id, { status: rejected.includes(error.message) ? 'failed' : 'delivery_unknown' });
  } finally {
    sending = false;
    refreshComposer();
    schedule(700);
  }
};

try {
  const auth = await api('auth', { initData: tg?.initData ?? '' });
  token = auth.token;
  $('preview').hidden = !auth.preview;
  tg?.ready();
  tg?.expand();
  document.addEventListener('visibilitychange', () => schedule(0));
  await refresh();
} catch {
  sessionsEl.replaceChildren();
  showConnection(tr('Abra o Mini App pelo Telegram com a conta autorizada.'));
  tg?.ready();
}
