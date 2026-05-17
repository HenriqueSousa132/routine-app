// ---- Constants ----
const CATS = {
  work:     { label: 'Trabalho', emoji: '💼', color: '#007aff' },
  health:   { label: 'Saúde',    emoji: '🏃', color: '#34c759' },
  personal: { label: 'Pessoal',  emoji: '⭐', color: '#af52de' },
  leisure:  { label: 'Lazer',    emoji: '🎮', color: '#ff9500' },
  other:    { label: 'Outro',    emoji: '📌', color: '#8e8e93' }
};

const PRIS = {
  high:   { label: 'Alta',  color: '#ff3b30' },
  medium: { label: 'Média', color: '#ff9500' },
  low:    { label: 'Baixa', color: '#34c759' }
};

const DAYS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const DAYS_LONG  = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MONTHS    = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

// ---- Storage ----
const DB = {
  getTasks:    () => JSON.parse(localStorage.getItem('tasks')    || '[]'),
  setTasks:    v  => localStorage.setItem('tasks', JSON.stringify(v)),
  getSettings: () => JSON.parse(localStorage.getItem('settings') || '{"notifications":false}'),
  setSettings: v  => localStorage.setItem('settings', JSON.stringify(v)),
};

// ---- State ----
let activeTab = 'today';
let filter = { category: 'all', priority: 'all' };
let editId = null;
let timers = {};

// ---- Bootstrap ----
document.addEventListener('DOMContentLoaded', () => {
  registerSW();
  bindNav();
  bindModal();
  renderToday();
  askNotifications();
  scheduleAll();
  setInterval(drawNowLine, 60000);
});

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ---- Navigation ----
function bindNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      document.getElementById('page-title').textContent = btn.dataset.title;
      activeTab = btn.dataset.tab;
      render(activeTab);
    });
  });
}

function render(tab) {
  if (tab === 'today')    renderToday();
  else if (tab === 'week')     renderWeek();
  else if (tab === 'tasks')    renderTasks();
  else if (tab === 'settings') renderSettings();
}

// ---- TODAY VIEW ----
function renderToday() {
  const el = document.getElementById('tab-today');
  const now = new Date();
  const todayIdx = now.getDay();
  const todayDate = isoDate(now);

  const items = DB.getTasks().filter(t =>
    (t.date && t.date === todayDate) ||
    (t.days && t.days.includes(todayIdx))
  );

  const byHour = {};
  const unscheduled = [];
  items.forEach(t => {
    if (t.startTime) {
      const h = +t.startTime.split(':')[0];
      (byHour[h] = byHour[h] || []).push(t);
    } else {
      unscheduled.push(t);
    }
  });

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

  let html = `<div class="today-header">
    <div class="today-date">${now.getDate()} ${MONTHS[now.getMonth()]}</div>
    <div class="today-weekday">${DAYS_LONG[todayIdx]}</div>
  </div>`;

  if (isIOS && !isStandalone) {
    html += `<div class="banner">📱 Para notificações no iPhone, adiciona ao Ecrã Inicial: Partilhar → "Adicionar ao Ecrã Inicial".</div>`;
  }

  if (items.length === 0) {
    html += emptyState('☀️', 'Dia livre!', 'Toca no + para adicionar uma tarefa ou bloco de rotina.');
  } else {
    html += '<div class="timeline" id="timeline">';
    for (let h = 6; h <= 23; h++) {
      const evs = byHour[h] || [];
      html += `<div class="timeline-slot" data-hour="${h}">
        <div class="timeline-hour">${pad(h)}:00</div>
        <div class="timeline-line"></div>
        <div class="timeline-events">${evs.map(eventBlock).join('')}</div>
      </div>`;
    }
    html += '</div>';

    if (unscheduled.length) {
      html += `<div class="section" style="margin-top:12px"><div class="section-title">Sem horário</div><div class="card">${unscheduled.map(taskRow).join('')}</div></div>`;
    }
  }

  el.innerHTML = html;
  drawNowLine();
}

function eventBlock(t) {
  const cat = CATS[t.category] || CATS.other;
  const done = t.completed ? ' done' : '';
  const time = t.startTime + (t.endTime ? '–' + t.endTime : '');
  return `<div class="event-block${done}" style="background:${cat.color}" onclick="openEdit('${t.id}')">
    <span>${cat.emoji}</span>
    <span style="flex:1">${esc(t.title)}</span>
    <span style="font-size:11px;opacity:0.85">${time}</span>
  </div>`;
}

function drawNowLine() {
  const tl = document.getElementById('timeline');
  if (!tl) return;
  tl.querySelectorAll('.now-indicator').forEach(n => n.remove());
  const now = new Date();
  const slot = tl.querySelector(`.timeline-slot[data-hour="${now.getHours()}"]`);
  if (!slot) return;
  const pct = now.getMinutes() / 60;
  const top = slot.offsetTop + pct * slot.offsetHeight;
  const ind = document.createElement('div');
  ind.className = 'now-indicator';
  ind.style.top = top + 'px';
  ind.innerHTML = '<div class="now-dot"></div><div class="now-line"></div>';
  tl.style.position = 'relative';
  tl.appendChild(ind);
}

// ---- WEEK VIEW ----
function renderWeek() {
  const el = document.getElementById('tab-week');
  const now = new Date();
  const todayIdx = now.getDay();

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((todayIdx + 6) % 7)); // Monday

  const days = Array.from({length: 7}, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  const tasks = DB.getTasks();
  const grid = days.map(d => {
    const dayN = d.getDay();
    const dateS = isoDate(d);
    const byH = {};
    tasks.forEach(t => {
      if (((t.date && t.date === dateS) || (t.days && t.days.includes(dayN))) && t.startTime) {
        const h = +t.startTime.split(':')[0];
        (byH[h] = byH[h] || []).push(t);
      }
    });
    return byH;
  });

  let html = '<div class="week-outer"><div class="week-header"><div></div>';
  days.forEach((d, i) => {
    const isToday = d.toDateString() === now.toDateString();
    html += `<div class="week-day-col">
      <div class="week-day-name">${DAYS_SHORT[(d.getDay())]}</div>
      <div class="day-num-circle${isToday ? ' today' : ''}">${d.getDate()}</div>
    </div>`;
  });
  html += '</div>';

  for (let h = 6; h <= 22; h++) {
    html += `<div class="week-row"><div class="week-hour-label">${pad(h)}h</div>`;
    days.forEach((_, i) => {
      const evs = grid[i][h] || [];
      html += '<div class="week-cell">' +
        evs.map(t => {
          const cat = CATS[t.category] || CATS.other;
          return `<div class="week-dot" style="background:${cat.color}" title="${esc(t.title)}"></div>`;
        }).join('') +
      '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
}

// ---- TASKS VIEW ----
function renderTasks() {
  const el = document.getElementById('tab-tasks');
  let tasks = DB.getTasks();

  if (filter.category !== 'all') tasks = tasks.filter(t => t.category === filter.category);
  if (filter.priority !== 'all') tasks = tasks.filter(t => t.priority === filter.priority);

  const priO = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (priO[a.priority] ?? 1) - (priO[b.priority] ?? 1);
  });

  let html = '<div class="filters">';
  html += chip('all', filter.category, 'Todas', "setFilter('category','all')");
  Object.entries(CATS).forEach(([k, v]) =>
    html += chip(k, filter.category, v.emoji + ' ' + v.label, `setFilter('category','${k}')`)
  );
  html += '</div><div class="filters" style="padding-top:0">';
  html += chip('all', filter.priority, 'Todas', "setFilter('priority','all')");
  Object.entries(PRIS).forEach(([k, v]) =>
    html += chip(k, filter.priority, v.label, `setFilter('priority','${k}')`)
  );
  html += '</div>';

  if (tasks.length === 0) {
    html += emptyState('✅', 'Sem tarefas', 'Toca no + para criar a tua primeira tarefa.');
  } else {
    html += `<div class="section"><div class="card">${tasks.map(taskRow).join('')}</div></div>`;
  }

  el.innerHTML = html;
}

function taskRow(t) {
  const cat = CATS[t.category] || CATS.other;
  const pri = PRIS[t.priority] || PRIS.medium;
  const days = t.days && t.days.length ? ' · ' + t.days.map(d => DAYS_SHORT[d]).join(' ') : '';
  return `<div class="task-item">
    <div class="task-check${t.completed ? ' done' : ''}" onclick="toggleDone(event,'${t.id}')">${t.completed ? '✓' : ''}</div>
    <div class="task-info" onclick="openEdit('${t.id}')">
      <div class="task-title${t.completed ? ' done' : ''}">${esc(t.title)}</div>
      <div class="task-meta">
        <div class="pri-dot" style="background:${pri.color}"></div>
        <span>${cat.emoji} ${cat.label}${days}</span>
      </div>
    </div>
    ${t.startTime ? `<div class="task-time">${t.startTime}</div>` : ''}
  </div>`;
}

function chip(val, active, label, onclick) {
  return `<button class="chip${active === val ? ' active' : ''}" onclick="${onclick}">${label}</button>`;
}

function setFilter(type, val) {
  filter[type] = val;
  renderTasks();
}

// ---- SETTINGS VIEW ----
function renderSettings() {
  const el = document.getElementById('tab-settings');
  const s = DB.getSettings();
  el.innerHTML = `
    <div class="section" style="margin-top:16px">
      <div class="section-title">Notificações</div>
      <div class="card">
        <div class="settings-item">
          <span class="settings-label">Ativar Notificações</span>
          <button class="toggle${s.notifications ? ' on' : ''}" onclick="toggleNotifs()"></button>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Dados</div>
      <div class="card">
        <div class="settings-item" onclick="exportJSON()">
          <span class="settings-label">Exportar dados</span>
          <span class="settings-value">JSON ›</span>
        </div>
        <div class="settings-item" onclick="document.getElementById('imp').click()">
          <span class="settings-label">Importar dados</span>
          <span class="settings-value">JSON ›</span>
        </div>
      </div>
      <input id="imp" type="file" accept=".json" style="display:none" onchange="importJSON(event)">
    </div>
    <div class="section">
      <div class="section-title">Sobre</div>
      <div class="card">
        <div class="settings-item">
          <span class="settings-label">Versão</span>
          <span class="settings-value">1.0.0</span>
        </div>
        <div class="settings-item" onclick="clearData()" style="cursor:pointer">
          <span class="settings-label" style="color:var(--danger)">Limpar todos os dados</span>
          <span class="settings-value">›</span>
        </div>
      </div>
    </div>`;
}

// ---- MODAL ----
function bindModal() {
  document.getElementById('btn-add').addEventListener('click', () => openAdd());
  document.getElementById('btn-save').addEventListener('click', saveTask);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
}

function openAdd() {
  editId = null;
  document.getElementById('modal-title').textContent = 'Nova Tarefa';
  fillModal(null);
  document.getElementById('modal-overlay').classList.add('open');
}

function openEdit(id) {
  editId = id;
  const t = DB.getTasks().find(t => t.id === id);
  if (!t) return;
  document.getElementById('modal-title').textContent = 'Editar Tarefa';
  fillModal(t);
  document.getElementById('modal-overlay').classList.add('open');
}

function fillModal(t) {
  const def = { title: '', category: 'personal', priority: 'medium', days: [], date: '', startTime: '', endTime: '' };
  const v = t || def;

  const catBtns = Object.entries(CATS).map(([k, c]) =>
    `<button class="chip-option${v.category===k?' sel':''}" style="color:${c.color}" data-group="cat" data-val="${k}" onclick="pickChip(this)">${c.emoji} ${c.label}</button>`
  ).join('');

  const priBtns = Object.entries(PRIS).map(([k, p]) =>
    `<button class="chip-option${v.priority===k?' sel':''}" style="color:${p.color}" data-group="pri" data-val="${k}" onclick="pickChip(this)">${p.label}</button>`
  ).join('');

  const dayBtns = DAYS_SHORT.map((d, i) =>
    `<button class="day-btn${v.days&&v.days.includes(i)?' sel':''}" data-day="${i}" onclick="toggleDay(this)">${d.substring(0,1)}</button>`
  ).join('');

  document.getElementById('modal-body').innerHTML = `<div class="form-group">
    <label class="form-label">Título</label>
    <input class="form-input" id="f-title" type="text" placeholder="O que precisas de fazer?" value="${esc(v.title)}" autocomplete="off">

    <label class="form-label">Categoria</label>
    <div class="chip-group" id="grp-cat">${catBtns}</div>

    <label class="form-label">Prioridade</label>
    <div class="chip-group" id="grp-pri">${priBtns}</div>

    <label class="form-label">Dias da semana (recorrente)</label>
    <div class="day-group" id="grp-day">${dayBtns}</div>

    <label class="form-label">Data específica (opcional)</label>
    <input class="form-input" id="f-date" type="date" value="${v.date || ''}">

    <label class="form-label">Horário</label>
    <div class="form-row">
      <input class="form-input" id="f-start" type="time" value="${v.startTime || ''}" placeholder="Início">
      <input class="form-input" id="f-end"   type="time" value="${v.endTime   || ''}" placeholder="Fim">
    </div>
    ${t ? `<button class="btn-danger" onclick="deleteTask('${t.id}')">Apagar Tarefa</button>` : ''}
  </div>`;

  setTimeout(() => document.getElementById('f-title')?.focus(), 100);
}

function pickChip(el) {
  const grp = document.getElementById('grp-' + el.dataset.group);
  grp.querySelectorAll('.chip-option').forEach(b => b.classList.remove('sel'));
  el.classList.add('sel');
}

function toggleDay(el) {
  el.classList.toggle('sel');
}

function readModal() {
  const title = document.getElementById('f-title')?.value.trim();
  if (!title) { toast('Adiciona um título!'); return null; }
  const cat = document.querySelector('#grp-cat .chip-option.sel')?.dataset.val || 'personal';
  const pri = document.querySelector('#grp-pri .chip-option.sel')?.dataset.val || 'medium';
  const days = [...document.querySelectorAll('#grp-day .day-btn.sel')].map(b => +b.dataset.day);
  return {
    title,
    category: cat,
    priority: pri,
    days,
    date:      document.getElementById('f-date')?.value  || '',
    startTime: document.getElementById('f-start')?.value || '',
    endTime:   document.getElementById('f-end')?.value   || '',
    notification: true
  };
}

function saveTask() {
  const data = readModal();
  if (!data) return;

  const tasks = DB.getTasks();
  if (editId) {
    const i = tasks.findIndex(t => t.id === editId);
    if (i >= 0) {
      tasks[i] = { ...tasks[i], ...data };
      DB.setTasks(tasks);
      cancelTimer(editId);
      scheduleTask(tasks[i]);
    }
    toast('Tarefa atualizada');
  } else {
    const t = { id: uid(), ...data, completed: false, createdAt: new Date().toISOString() };
    tasks.push(t);
    DB.setTasks(tasks);
    scheduleTask(t);
    toast('Tarefa criada!');
  }
  closeModal();
  render(activeTab);
}

function deleteTask(id) {
  if (!confirm('Apagar esta tarefa?')) return;
  DB.setTasks(DB.getTasks().filter(t => t.id !== id));
  cancelTimer(id);
  closeModal();
  render(activeTab);
  toast('Tarefa apagada');
}

function toggleDone(e, id) {
  e.stopPropagation();
  const tasks = DB.getTasks();
  const i = tasks.findIndex(t => t.id === id);
  if (i >= 0) { tasks[i].completed = !tasks[i].completed; DB.setTasks(tasks); render(activeTab); }
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// ---- NOTIFICATIONS ----
async function askNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    const res = await Notification.requestPermission();
    const s = DB.getSettings();
    s.notifications = res === 'granted';
    DB.setSettings(s);
  }
}

async function toggleNotifs() {
  const s = DB.getSettings();
  if (s.notifications) {
    s.notifications = false;
    DB.setSettings(s);
    Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k]; });
    toast('Notificações desativadas');
  } else {
    const res = await Notification.requestPermission();
    s.notifications = res === 'granted';
    DB.setSettings(s);
    if (res === 'granted') { scheduleAll(); toast('Notificações ativas!'); }
    else toast('Permissão negada pelo sistema');
  }
  renderSettings();
}

function scheduleTask(t) {
  if (!t.startTime) return;
  if (!DB.getSettings().notifications) return;
  if (Notification.permission !== 'granted') return;

  const now = Date.now();
  const [h, m] = t.startTime.split(':').map(Number);

  const fire = (date) => {
    const target = new Date(date);
    target.setHours(h, m, 0, 0);
    const delay = target - now;
    if (delay < 0 || delay > 7 * 86400000) return;
    const key = t.id + '_' + target.toISOString();
    timers[key] = setTimeout(() => {
      const cat = CATS[t.category] || CATS.other;
      const pri = PRIS[t.priority] || PRIS.medium;
      const body = `${cat.emoji} ${cat.label} · ${pri.label}`;
      navigator.serviceWorker?.ready
        .then(reg => reg.showNotification(t.title, { body, icon: './icon-192.svg', badge: './icon-192.svg', tag: t.id }))
        .catch(() => new Notification(t.title, { body, tag: t.id }));
    }, delay);
  };

  if (t.date) {
    fire(new Date(t.date));
  } else if (t.days && t.days.length) {
    const todayN = new Date().getDay();
    t.days.forEach(d => {
      let ahead = d - todayN;
      if (ahead < 0) ahead += 7;
      const target = new Date();
      target.setDate(target.getDate() + ahead);
      fire(target);
    });
  }
}

function scheduleAll() {
  DB.getTasks().forEach(scheduleTask);
}

function cancelTimer(id) {
  Object.keys(timers).filter(k => k.startsWith(id)).forEach(k => {
    clearTimeout(timers[k]);
    delete timers[k];
  });
}

// ---- SETTINGS ACTIONS ----
function exportJSON() {
  const blob = new Blob([JSON.stringify({ tasks: DB.getTasks(), exported: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'rotina-' + isoDate(new Date()) + '.json' });
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Dados exportados!');
}

function importJSON(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const d = JSON.parse(ev.target.result);
      if (Array.isArray(d.tasks)) {
        DB.setTasks(d.tasks);
        scheduleAll();
        render(activeTab);
        toast(`${d.tasks.length} tarefas importadas!`);
      }
    } catch { toast('Erro ao importar'); }
  };
  r.readAsText(f);
  e.target.value = '';
}

function clearData() {
  if (!confirm('Apagar TODOS os dados? Esta ação é irreversível.')) return;
  localStorage.clear();
  Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k]; });
  render(activeTab);
  toast('Dados apagados');
}

// ---- HELPERS ----
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return d.toISOString().split('T')[0]; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function emptyState(icon, title, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-title">${title}</div><div class="empty-text">${text}</div></div>`;
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}
