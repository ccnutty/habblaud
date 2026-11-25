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
const activityLabels = {
  prompt: 'Instrução recebida', think: 'Analisando', respond: 'Preparando resposta',
  read: 'Leitura', search: 'Busca', edit: 'Edição', write: 'Escrita', run: 'Comando em execução',
  test: 'Teste', git: 'Operação Git', web: 'Pesquisa na web', browser: 'Navegação',
  plan: 'Planejamento', delegate: 'Tarefa delegada', communicate: 'Mensagem entre agentes',
  ask: 'Pergunta para você', mcp: 'Ferramenta externa', skill: 'Habilidade acionada',
  wait: 'Aguardando', error: 'Erro', compact: 'Contexto resumido', done: 'Turno concluído',
};
const fileActivityLabels = { read: 'Lendo {0}', edit: 'Editando {0}', write: 'Escrevendo {0}' };
const connectionErrors = {
  mac_offline: 'O Mac está desconectado.',
  upstream_unavailable: 'O Mac está conectado, mas o Habblaud local não respondeu.',
  bridge_timeout: 'O Mac demorou para responder.',
  not_authorized: 'Abra o Mini App pelo Telegram com a conta autorizada.',
};
const tg = window.Telegram?.WebApp;
const instruction = $('instruction');
const send = $('send');
const drafts = new Map();
const receipts = new Map();
const signatures = new WeakMap();
const collapsed = new Set();
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const number = new Intl.NumberFormat();
const tabs = ['overview', 'projects', 'activity', 'office'];
const screens = [...tabs, 'project', 'detail'];
const working = ({ status }) => status === 'working' || status === 'shell';

let token;
let authenticated = false;
let office;
let sessions = [];
let projects = [];
let route = { screen: 'overview' };
let tabOnBack;
let selected;
let providerFilter = '';
let connectionError = '';
let lastSync;
let sending = false;
let conversationSignature;
let refreshTimer;
let refreshing = false;
let refreshRequested = false;
let roomName;
let art;

if (tg?.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;
document.documentElement.lang = navigator.language;
for (const item of document.querySelectorAll('[data-i18n]')) item.textContent = tr(item.dataset.i18n);
for (const item of document.querySelectorAll('[data-label]')) item.setAttribute('aria-label', tr(item.dataset.label));
for (const item of document.querySelectorAll('[data-placeholder]')) {
  const label = tr(item.dataset.placeholder);
  item.placeholder = label;
  item.setAttribute('aria-label', label);
}
instruction.placeholder = tr('Escreva uma instrução');
instruction.setAttribute('aria-label', instruction.placeholder);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name, className = 'icon') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#icon-' + name);
  svg.append(use);
  return svg;
}

function tile(symbol, provider) {
  const node = element('span', 'tile');
  if (provider) node.dataset.provider = provider;
  node.append(icon(symbol));
  return node;
}

function copy(title, subtitle) {
  const node = element('span', 'row-copy');
  node.append(element('strong', '', title), element('small', '', subtitle));
  return node;
}

function button(className, action) {
  const node = element('button', className);
  node.type = 'button';
  node.onclick = action;
  return node;
}

function paint(id, data, build) {
  const node = $(id);
  const signature = JSON.stringify(data);
  if (signatures.get(node) === signature) return;
  signatures.set(node, signature);
  node.replaceChildren(...build());
}

function empty(loadedText) {
  return element('p', 'empty card', tr(office ? loadedText :
    connectionError ? 'Dados indisponíveis.' : 'Carregando sessões…'));
}

function projectName(session) {
  return session.project || tr('Sem projeto');
}

function providerName(session) {
  return names[session.provider] ?? session.provider;
}

function subline(values) {
  return values.filter(Boolean).join(' · ');
}

function sessionCount(count) {
  return tr(count === 1 ? '{0} sessão' : '{0} sessões', [number.format(count)]);
}

function projectCount(count) {
  return tr(count === 1 ? '{0} projeto' : '{0} projetos', [number.format(count)]);
}

function activityCount(count) {
  return tr('{0} em atividade', [number.format(count)]);
}

function projectGroups(items) {
  const groups = new Map();
  for (const session of items) {
    const name = projectName(session);
    if (!groups.has(name)) groups.set(name, { name, items: [] });
    groups.get(name).items.push(session);
  }
  return [...groups.values()].map((project) => ({
    ...project,
    active: project.items.filter(working).length,
    waiting: project.items.filter(({ status }) => status === 'waiting').length,
  }));
}

function showConnection(error = '') {
  connectionError = error;
  const state = error ? 'error' : office ? 'online' : 'loading';
  $('sync').dataset.state = state;
  $('sync-label').textContent = tr(error === 'mac_offline' ? 'Mac offline' :
    error ? 'Conexão limitada' : office ? 'Conectado' : 'Conectando');
  $('sync').setAttribute('aria-label', subline([tr('Atualizar'), $('sync-label').textContent]));
  const message = error && tr(connectionErrors[error] ?? 'Não foi possível atualizar.');
  $('connection').textContent = subline([message, error && office && tr('Mostrando a última atualização.')]);
  $('connection').hidden = !error;
}

function statusText(agent) {
  const minutes = Math.floor((Date.now() - agent.statusSince) / 60_000);
  if (agent.status === 'idle' && minutes >= 1) {
    const hours = Math.floor(minutes / 60);
    const duration = hours ? tr('{0} h {1} min', [number.format(hours), number.format(minutes % 60)]) :
      tr('{0} min', [number.format(minutes)]);
    return tr('Ocioso há {0}', [duration]);
  }
  return tr(statuses[agent.status] ?? 'Desconectado');
}

function agentActivity(agent) {
  if (!agent.activityKind) return '';
  const label = fileActivityLabels[agent.activityKind];
  return label && agent.activityFile ? tr(label, [agent.activityFile]) :
    tr(activityLabels[agent.activityKind] ?? 'Sessão atualizada');
}

function avatar(agent, sub) {
  if (!art || !Number.isInteger(agent.seed)) return tile(agent.provider, agent.provider);
  const canvas = element('canvas', 'pixel-avatar');
  canvas.setAttribute('aria-hidden', 'true');
  return art.drawAvatar(canvas, { ...agent, sub }) ? canvas : tile(agent.provider, agent.provider);
}

function accountBadge(agent) {
  const badge = element('span', 'account-badge', agent.badge || (agent.provider === 'codex' ? 'X' : 'A'));
  badge.dataset.provider = agent.provider;
  badge.title = providerName(agent);
  badge.setAttribute('aria-label', providerName(agent));
  return badge;
}

function openAgent(session, sub) {
  navigate({ screen: 'detail', id: session.id, subId: sub?.id });
}

function sessionRow(session, showProject = false, sub) {
  const agent = sub ?? session;
  const row = button('row session-row card', () => openAgent(session, sub));
  const copy = element('span', 'row-copy agent-copy');
  const name = element('span', 'agent-name');
  name.append(element('strong', '', agent.name || agent.title), accountBadge(agent));
  copy.append(name);
  if (agent.name && agent.title !== agent.name) copy.append(element('span', 'agent-task', agent.title));
  const meta = subline([showProject && projectName(session), sub?.role, agentActivity(agent)]);
  if (meta) copy.append(element('small', 'agent-activity', meta));
  const status = element('span', 'status');
  status.dataset.status = agent.status;
  status.append(element('span', 'dot'), statusText(agent));
  row.append(avatar(agent, Boolean(sub)), copy, status);
  return row;
}

function sessionGroup(session) {
  const group = element('div', 'agent-group');
  group.append(sessionRow(session));
  if (session.subagents) {
    const label = tr('{0} subag.', [number.format(session.subagents)]);
    const children = session.subagentDetails ?? [];
    if (!children.length) {
      group.append(element('p', 'agent-activity', label));
      return group;
    }
    const disclosure = element('details', 'agent-children');
    disclosure.open = !collapsed.has(session.id);
    disclosure.ontoggle = () => {
      if (disclosure.open) collapsed.delete(session.id);
      else collapsed.add(session.id);
    };
    const list = element('div', 'stack child-rows');
    list.append(...children.map((child) => sessionRow(session, false, child)));
    disclosure.append(element('summary', '', label), list);
    group.append(disclosure);
  }
  return group;
}

function rosterSignature(items) {
  const idle = items.some(({ status, subagentDetails }) =>
    status === 'idle' || subagentDetails?.some((sub) => sub.status === 'idle'));
  return [items, Boolean(art), idle ? Math.floor(Date.now() / 60_000) : 0];
}

function projectRow(project) {
  const row = button('row card', () => navigate({ screen: 'project', name: project.name }));
  const title = copy(project.name, subline([sessionCount(project.items.length), activityCount(project.active)]));
  row.append(tile('projects'), title);
  if (project.waiting) {
    const badge = element('span', 'count waiting-count', number.format(project.waiting));
    badge.setAttribute('aria-label', tr('{0} precisam de você', [number.format(project.waiting)]));
    row.append(badge);
  }
  row.append(icon('chevron', 'icon row-chevron'));
  return row;
}

function accountRow(account) {
  const card = element('article', 'account card');
  const head = element('div', 'row');
  const qualifier = account.usageStatus === 'stale' ? tr('Uso desatualizado') : '';
  head.append(tile(account.provider, account.provider), copy(account.name, subline([providerName(account), qualifier])));
  card.append(head);
  const windows = [['5 horas', account.fiveHour], ['Semanal', account.sevenDay]].filter(([, value]) => value);
  if (!windows.length) card.append(element('p', 'hero-meta', tr(account.noQuota ? 'Sem cota disponível' : 'Sem dados de uso')));
  for (const [name, usage] of windows) {
    const quota = element('div', 'quota');
    const progress = element('progress');
    progress.max = 100;
    progress.value = usage.utilization;
    progress.setAttribute('aria-label', tr(name));
    quota.append(element('span', '', tr(name)), element('span', '', number.format(usage.utilization) + '%'), progress);
    if (Number.isFinite(usage.resetsAt)) quota.append(element('small', '', tr('Renova {0}', [dateTime.format(usage.resetsAt)])));
    card.append(quota);
  }
  return card;
}

function renderOverview() {
  const waiting = sessions.filter((session) => session.status === 'waiting');
  const active = sessions.filter(working);
  $('working-count').textContent = office ? number.format(active.length) : '–';
  $('hero-meta').textContent = office ? projectCount(projects.length) : '';
  $('overview-meta').textContent = lastSync ? tr('Atualizado às {0}', [clock.format(lastSync)]) :
    tr(connectionError ? 'Dados indisponíveis.' : 'Carregando sessões…');
  const subs = office && sessions.every((session) => Number.isInteger(session.subagents)) ?
    sessions.reduce((count, session) => count + session.subagents, 0) : undefined;
  const metrics = [
    ['Sessões', office && sessions.length],
    ['Aguardando você', office && waiting.length],
    ['Subagentes', subs],
  ];
  paint('metrics', metrics, () => metrics.map(([label, value]) => {
    const metric = element('div', 'metric');
    metric.append(element('strong', '', value != null ? number.format(value) : '–'), element('span', '', tr(label)));
    return metric;
  }));
  $('waiting-count').textContent = number.format(waiting.length);
  $('waiting-count').hidden = !waiting.length;
  paint('waiting-list', [waiting, !!office, !!connectionError, Boolean(art)], () => {
    if (waiting.length) {
      const rows = element('div', 'stack');
      rows.append(...waiting.map((session) => sessionRow(session, true)));
      return [rows];
    }
    return [empty('Nenhuma sessão precisa de você.')];
  });
  const recentProjects = projects.slice(0, 3);
  paint('overview-projects', [recentProjects, !!office, !!connectionError], () => recentProjects.length ?
    recentProjects.map((project) => projectRow(project)) : [empty('Nenhum projeto ativo.')]);
  $('usage').hidden = !office?.accounts?.length;
  paint('accounts', office?.accounts, () => (office?.accounts ?? []).map(accountRow));
}

function renderProjects() {
  const query = $('project-search').value.trim().toLocaleLowerCase();
  const matches = sessions.filter((session) => {
    if (providerFilter && session.provider !== providerFilter) return false;
    const children = (session.subagentDetails ?? []).flatMap(({ name, title }) => [name, title]);
    const searchable = [projectName(session), session.name, session.title, ...children].filter(Boolean).join(' ').toLocaleLowerCase();
    return !query || searchable.includes(query);
  });
  const groups = projectGroups(matches);
  $('projects-meta').textContent = office ? subline([projectCount(groups.length), sessionCount(matches.length)]) : '';
  for (const filter of $('provider-filters').children) {
    filter.setAttribute('aria-pressed', String(filter.dataset.provider === providerFilter));
  }
  paint('project-list', [groups, !!office, !!connectionError], () => groups.length ?
    groups.map((project) => projectRow(project)) : [empty(query || providerFilter ? 'Nenhum resultado.' : 'Nenhum projeto ativo.')]);
}

function renderActivity() {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const recent = office?.activity ?? sessions.filter((session) => Number.isFinite(session.updatedAt))
    .map((session) => ({ sessionId: session.id, at: session.updatedAt }))
    .sort((a, b) => b.at - a.at).slice(0, 24);
  const entries = recent.flatMap((entry) => {
    const session = sessionById.get(entry.sessionId);
    return session ? [{ entry, session }] : [];
  });
  paint('activity-list', [entries, !!office, !!connectionError], () => entries.length ?
    entries.map(({ entry, session }) => {
      const row = button('row card', () => navigate({ screen: 'detail', id: session.id }));
      const at = new Date(entry.at);
      const time = element('time', 'activity-time',
        at.toDateString() === new Date().toDateString() ? clock.format(at) : dateTime.format(at));
      time.dateTime = at.toISOString();
      row.append(tile('activity', session.provider),
        copy(tr(activityLabels[entry.kind] ?? 'Sessão atualizada'), subline([entry.agent ?? session.name, projectName(session), session.title])),
        time);
      return row;
    }) : [empty('Nenhuma atividade recente.')]);
}

function renderRooms() {
  const rooms = new Map((office?.rooms ?? []).map((room) => [room.name, { ...room, items: [] }]));
  for (const project of projects) rooms.set(project.name, { ...rooms.get(project.name), ...project });
  if (!rooms.has(roomName)) roomName = rooms.keys().next().value;
  const room = rooms.get(roomName);
  paint('room-list', [...rooms.keys()], () => [...rooms.keys()].map((name) => {
    const tab = button('filter', () => { roomName = name; renderRooms(); });
    tab.textContent = name;
    return tab;
  }));
  for (const tab of $('room-list').children) tab.setAttribute('aria-pressed', String(tab.textContent === roomName));
  const roster = room?.items ?? [];
  paint('room-view', [room, rosterSignature(roster), !!office, !!connectionError], () => {
    if (!room) return [empty('Nenhum projeto ativo.')];
    const view = element('div', 'stack room-view');
    const members = roster.flatMap((session) => [
      { agent: session, session },
      ...(session.subagentDetails ?? []).map((sub) => ({ agent: sub, session, sub })),
    ]).filter(({ agent }) => !['done', 'offline'].includes(agent.status));
    const players = members.filter(({ agent }) => Number.isInteger(agent.seed));
    if (art && Number.isInteger(room.seed)) {
      const scene = element('div', 'room-scene');
      const canvas = element('canvas', 'room-canvas');
      canvas.setAttribute('aria-hidden', 'true');
      scene.append(canvas);
      const labels = art.drawRoom(canvas, room, players.map(({ agent, sub }) => ({ ...agent, sub: Boolean(sub) })));
      for (const [index, point] of labels.entries()) {
        const { agent, session, sub } = players[index];
        const marker = button('room-marker', () => openAgent(session, sub));
        marker.style.left = point.x + '%';
        marker.style.top = point.y + '%';
        marker.setAttribute('aria-label', subline([agent.name, providerName(agent), statusText(agent)]));
        const chip = element('span', 'marker-chip');
        chip.append(accountBadge(agent), element('span', 'marker-name', agent.name));
        marker.append(chip);
        scene.append(marker);
      }
      view.append(scene);
      if (players.length > labels.length) view.append(element('p', 'hero-meta', tr('Mais agentes na lista abaixo.')));
    } else {
      const fallback = element('img', 'office-art');
      fallback.src = '/office.png';
      fallback.alt = '';
      view.append(fallback);
    }
    const header = element('div', 'section-head');
    header.append(element('h2', '', tr('Agentes da sala')), element('span', 'count', number.format(members.length)));
    view.append(header, ...(roster.length ? roster.map(sessionGroup) : [empty('Nenhuma sessão ativa.')]));
    return [view];
  });
}

function renderProject() {
  const project = projects.find(({ name }) => name === route.name);
  $('project-title').textContent = route.name;
  $('project-meta').textContent = project ? subline([sessionCount(project.items.length), activityCount(project.active)]) : '';
  paint('project-sessions', [rosterSignature(project?.items ?? []), !!office, !!connectionError], () => project ?
    project.items.map(sessionGroup) : [empty('Nenhuma sessão ativa.')]);
}

function refreshComposer() {
  const session = sessions.find(({ id }) => id === selected);
  const receipt = receipts.get(selected);
  const locked = !session?.canMessage;
  instruction.disabled = locked;
  send.disabled = locked || !!connectionError || sending || !instruction.value.trim();
  const label = receipt ? tr(deliveries[receipt.status] ?? deliveries.failed) :
    locked ? tr('Esta sessão está sem canal de mensagens.') : '';
  $('delivery').textContent = label;
  $('delivery').hidden = !label;
}

function renderDetail() {
  const session = sessions.find(({ id }) => id === route.id);
  const sub = session?.subagentDetails?.find(({ id }) => id === route.subId);
  const subView = Boolean(route.subId);
  $('conversation').hidden = subView;
  $('composer').hidden = subView;
  $('sub-detail').hidden = !subView;
  if (subView) {
    $('detail-title').textContent = sub?.name ?? tr('Subagente');
    $('detail-meta').textContent = session ? subline([projectName(session), tr('Subagente'), providerName(sub ?? session)]) : '';
    paint('sub-detail', [session, sub, Boolean(art)], () => {
      const card = element('article', 'card sub-profile');
      const heading = element('div', 'row');
      if (sub) {
        heading.append(avatar(sub, true), copy(sub.title, subline([sub.role, statusText(sub)])));
        card.append(heading);
        if (sub.activityKind) card.append(element('p', 'hero-meta', agentActivity(sub)));
      } else card.append(element('p', 'hero-meta', tr('A sessão não está disponível.')));
      if (session) {
        const parent = button('text-button', () => openAgent(session));
        parent.textContent = tr('Abrir sessão principal');
        card.append(parent);
      }
      return [card];
    });
    return;
  }
  if (session) $('detail-title').textContent = session.title;
  $('detail-meta').textContent = session ? subline([projectName(session), session.name, providerName(session),
    tr(statuses[session.status] ?? 'Desconectado')]) : tr('A sessão não está disponível.');
  refreshComposer();
}

function renderScreen() {
  const render = {
    overview: renderOverview, projects: renderProjects, activity: renderActivity,
    office: renderRooms, project: renderProject, detail: renderDetail,
  };
  render[route.screen]();
}

function showRoute(next, moveFocus = false) {
  const previous = selected;
  if (previous) drafts.set(previous, instruction.value);
  route = next;
  selected = route.screen === 'detail' && !route.subId ? route.id : undefined;
  for (const screen of screens) $(screen).hidden = screen !== route.screen;
  const deep = !tabs.includes(route.screen);
  $('navigation').hidden = route.screen === 'detail';
  for (const tab of $('navigation').querySelectorAll('button')) {
    if (tab.dataset.screen === (deep ? route.root : route.screen)) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (deep) tg?.BackButton?.show();
  else tg?.BackButton?.hide();
  if (selected && selected !== previous) {
    instruction.value = drafts.get(selected) ?? '';
    $('detail-title').textContent = sessions.find(({ id }) => id === selected)?.title ?? '';
    $('conversation').textContent = tr('Carregando conversa…');
    conversationSignature = undefined;
    schedule(0);
  }
  renderScreen();
  window.scrollTo(0, 0);
  if (moveFocus) {
    const heading = $(route.screen).querySelector('h1');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function navigate(next) {
  if (tabs.includes(next.screen)) {
    if (route.root) {
      tabOnBack = next;
      history.back();
      return;
    }
    if (next.screen === route.screen) return;
    history.replaceState(next, '');
  } else {
    next.root = route.root ?? route.screen;
    history.pushState(next, '');
  }
  showRoute(next, true);
}

function back() {
  if (route.root) history.back();
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
    const byline = element('div', 'byline', entry.role === 'user' ? tr('Você') : names[sessions.find(({ id }) => id === selected)?.provider] ?? 'Habblaud');
    if (Number.isFinite(entry.at)) byline.append(element('time', '', clock.format(entry.at)));
    bubble.append(byline, element('p', '', entry.text));
    feed.append(bubble);
  }
  if (follow) window.scrollTo(0, document.documentElement.scrollHeight);
}

async function api(path, data) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/' + path, {
    method: data ? 'POST' : 'GET', headers,
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.code ?? 'unavailable');
  return result;
}

async function authenticate() {
  const auth = await api('auth', { initData: tg?.initData ?? '' });
  token = auth.token;
  authenticated = true;
  $('preview').hidden = !auth.preview;
  tg?.expand();
}

async function refreshDetail(id) {
  try {
    const conversation = await api('sessions/' + encodeURIComponent(id) + '/conversation');
    if (id === selected) renderConversation(conversation);
  } catch {
    if (id === selected && conversationSignature === undefined) $('conversation').textContent = tr('Não foi possível carregar as mensagens.');
  }
  const receipt = receipts.get(id);
  if (id !== selected || !receipt?.id || !['queued', 'sent'].includes(receipt.status)) return;
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

async function refresh() {
  if (refreshing) {
    refreshRequested = true;
    return;
  }
  refreshing = true;
  $('sync').disabled = true;
  try {
    if (!authenticated) await authenticate();
    office = await api('overview');
    sessions = office.sessions;
    projects = projectGroups(sessions);
    lastSync = Date.now();
    showConnection();
    renderScreen();
    if (selected && sessions.some(({ id }) => id === selected)) await refreshDetail(selected);
  } catch (error) {
    if (error.message === 'not_authorized') authenticated = false;
    showConnection(error.message || 'unavailable');
    renderScreen();
  } finally {
    refreshing = false;
    $('sync').disabled = false;
    tg?.ready();
    const delay = refreshRequested ? 0 : selected ? 3500 : 5500;
    refreshRequested = false;
    if (authenticated) schedule(delay);
  }
}

function schedule(delay) {
  clearTimeout(refreshTimer);
  if (!document.hidden) refreshTimer = setTimeout(refresh, delay);
}

for (const provider of ['', 'codex', 'claude']) {
  const filter = button('filter', () => { providerFilter = provider; renderProjects(); });
  filter.dataset.provider = provider;
  filter.textContent = provider ? names[provider] : tr('Todos');
  $('provider-filters').append(filter);
}
$('project-search').oninput = renderProjects;
for (const node of document.querySelectorAll('[data-screen]')) {
  node.onclick = () => navigate({ screen: node.dataset.screen });
}
$('sync').onclick = () => schedule(0);
$('back').onclick = back;
$('project-back').onclick = back;
tg?.BackButton?.onClick(back);
window.addEventListener('popstate', ({ state }) => {
  const next = tabOnBack ?? state ?? { screen: 'overview' };
  if (tabOnBack) history.replaceState(next, '');
  tabOnBack = undefined;
  showRoute(next, true);
});
document.addEventListener('visibilitychange', () => { if (authenticated) schedule(0); });
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

history.replaceState(route, '');
showConnection();
renderScreen();
void import('/office-art.mjs').then((module) => {
  art = module;
  renderScreen();
}).catch(() => {});
await refresh();
