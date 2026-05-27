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

// Map from any day string the old app might have used → 0-6
const DAY_STR_MAP = {
  sun:0, dom:0, domingo:0,
  mon:1, seg:1, segunda:1,
  tue:2, ter:2, terca:2, 'terça':2,
  wed:3, qua:3, quarta:3,
  thu:4, qui:4, quinta:4,
  fri:5, sex:5, sexta:5,
  sat:6, sab:6, 'sáb':6, sabado:6, 'sábado':6
};

function normDays(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(d => {
    if (typeof d === 'number') return d;
    if (typeof d === 'string') {
      const n = DAY_STR_MAP[d.toLowerCase().trim()];
      return n !== undefined ? n : null;
    }
    return null;
  }).filter(d => d !== null);
}

// ---- Storage ----
const DB = {
  getTasks:    () => JSON.parse(localStorage.getItem('tasks') || '[]').map(t => ({ ...t, days: normDays(t.days) })),
  setTasks:    v  => localStorage.setItem('tasks', JSON.stringify(v)),
  getSettings: () => JSON.parse(localStorage.getItem('settings') || '{"notifications":false}'),
  setSettings: v  => localStorage.setItem('settings', JSON.stringify(v)),
  getHealth:   d  => JSON.parse(localStorage.getItem('health_' + d) || '{"water":0,"meals":[]}'),
  setHealth:   (d,v) => localStorage.setItem('health_' + d, JSON.stringify(v)),
  getGoals:    () => JSON.parse(localStorage.getItem('goals') || '{"water":2000,"calories":2000}'),
  setGoals:    v  => localStorage.setItem('goals', JSON.stringify(v)),
};

// ---- State ----
let filter = { category: 'all', priority: 'all' };
let editId = null;
let timers = {};
let nowLineInterval = null;
let modalMode = 'task';
let modalContext = null;
let foodSearchTimer = null;

// ---- Bootstrap ----
document.addEventListener('DOMContentLoaded', () => {
  registerSW();
  bindModal();
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  migrateOldData();
  renderDashboard();
  syncNotifState();
  scheduleAll();
  nowLineInterval = setInterval(drawNowLine, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(nowLineInterval);
      nowLineInterval = null;
    } else {
      drawNowLine();
      nowLineInterval = setInterval(drawNowLine, 60000);
    }
  });
});

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ---- DATA MIGRATION (old app → new app) ----
function migrateOldData() {
  if (DB.getTasks().length > 0) return; // already have data
  const found = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === 'tasks') continue;
    try {
      const val = JSON.parse(localStorage.getItem(key));
      // detect arrays of task-like objects
      if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object') {
        const sample = val[0];
        if ('title' in sample || 'name' in sample || 'task' in sample || 'text' in sample) {
          found.push({ key, data: val });
        }
      }
      // detect objects that wrap a task array
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const arr = val.tasks || val.items || val.list;
        if (Array.isArray(arr) && arr.length > 0) {
          found.push({ key, data: arr });
        }
      }
    } catch {}
  }
  if (!found.length) return;

  // normalise and import the best candidate (most items)
  found.sort((a, b) => b.data.length - a.data.length);
  const raw = found[0].data;
  const migrated = raw.map(t => ({
    id:        t.id || uid(),
    title:     t.title || t.name || t.task || t.text || 'Tarefa importada',
    category:  t.category || t.cat || 'personal',
    priority:  t.priority || t.pri || 'medium',
    days:      normDays(t.days || t.weekDays || t.recurDays || t.repeat),
    date:      t.date || t.dueDate || '',
    startTime: t.startTime || t.time || t.start || '',
    endTime:   t.endTime || t.end || '',
    completed: !!(t.completed || t.done || t.checked),
    createdAt: t.createdAt || new Date().toISOString(),
    notification: true,
  }));
  DB.setTasks(migrated);
  toast(`${migrated.length} tarefas recuperadas ✅`);
}

// ---- NOTIFICATION SYNC ----
function syncNotifState() {
  if (!('Notification' in window)) return;
  const s = DB.getSettings();
  const actual = Notification.permission === 'granted';
  if (actual !== s.notifications) {
    s.notifications = actual;
    DB.setSettings(s);
  }
}

// ---- DASHBOARD ----
function renderDashboard() {
  const el = document.getElementById('dashboard');
  const now = new Date();
  const todayIdx = now.getDay();
  const todayDate = isoDate(now);

  document.getElementById('page-title').textContent = now.getDate() + ' ' + MONTHS[now.getMonth()];
  document.getElementById('page-weekday').textContent = DAYS_LONG[todayIdx];

  const allTasks = DB.getTasks();
  const todayTasks = allTasks.filter(t =>
    (t.date && t.date === todayDate) || (t.days && t.days.includes(todayIdx))
  );
  const byHour = {};
  const unscheduled = [];
  todayTasks.forEach(t => {
    if (t.startTime) { const h = +t.startTime.split(':')[0]; (byHour[h] = byHour[h] || []).push(t); }
    else unscheduled.push(t);
  });

  let html = '';

  // Health
  html += renderHealthWidgets(todayDate);

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !isStandalone) {
    html += `<div class="banner" style="margin-bottom:0">📱 Adiciona ao Ecrã Inicial para activar notificações.</div>`;
  }

  // Agenda
  html += `<div class="section" style="margin-top:20px"><div class="section-title">Agenda de hoje</div>`;
  const scheduledHours = Object.keys(byHour).map(Number);
  if (scheduledHours.length) {
    const minH = Math.max(0, Math.min(...scheduledHours) - 1);
    const maxH = Math.min(23, Math.max(...scheduledHours) + 1);
    html += '<div class="timeline" id="timeline">';
    for (let h = minH; h <= maxH; h++) {
      const evs = byHour[h] || [];
      html += `<div class="timeline-slot" data-hour="${h}">
        <div class="timeline-hour">${pad(h)}:00</div>
        <div class="timeline-line"></div>
        <div class="timeline-events">${evs.map(eventBlock).join('')}</div>
      </div>`;
    }
    html += '</div>';
  } else {
    html += `<p class="ds-empty-text">Sem eventos agendados para hoje.</p>`;
  }
  if (unscheduled.length) {
    html += `<div class="card" style="margin-top:8px">${unscheduled.map(taskRow).join('')}</div>`;
  }
  html += '</div>';

  // Tasks
  let tasks = allTasks;
  if (filter.category !== 'all') tasks = tasks.filter(t => t.category === filter.category);
  if (filter.priority !== 'all') tasks = tasks.filter(t => t.priority === filter.priority);
  const priO = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (priO[a.priority] ?? 1) - (priO[b.priority] ?? 1);
  });
  html += `<div class="section"><div class="section-title">Tarefas</div>
    <div class="filters">`;
  html += chip('all', filter.category, 'Todas', "setFilter('category','all')");
  Object.entries(CATS).forEach(([k, v]) =>
    html += chip(k, filter.category, v.emoji + ' ' + v.label, `setFilter('category','${k}')`)
  );
  html += `</div><div class="filters" style="padding-top:0">`;
  html += chip('all', filter.priority, 'Todas', "setFilter('priority','all')");
  Object.entries(PRIS).forEach(([k, v]) =>
    html += chip(k, filter.priority, v.label, `setFilter('priority','${k}')`)
  );
  html += '</div>';
  if (tasks.length === 0) {
    html += emptyState('✅', 'Sem tarefas', 'Toca no + para criar a tua primeira tarefa.');
  } else {
    html += `<div class="card">${tasks.map(taskRow).join('')}</div>`;
  }
  html += '</div>';

  // Week
  html += `<div class="section"><div class="section-title">Esta semana</div>${renderWeekContent(now, allTasks)}</div>`;

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

// ---- HEALTH WIDGETS ----
function renderHealthWidgets(date) {
  const h = DB.getHealth(date);
  const g = DB.getGoals();

  const waterPct = Math.min(100, h.water / g.water * 100);
  const totalKcal = h.meals.reduce((s, m) => s + m.kcal, 0);
  const calPct = Math.min(100, totalKcal / g.calories * 100);
  const calOver = totalKcal > g.calories;

  const waterLabel = h.water >= 1000
    ? (h.water / 1000).toFixed(1).replace(/\.0$/, '') + ' L'
    : h.water + ' ml';
  const goalWater = g.water >= 1000 ? (g.water / 1000) + ' L' : g.water + ' ml';

  const recentMeals = h.meals.slice(-3).map(m =>
    `<div class="meal-item"><span>${esc(m.name)}</span><span class="meal-kcal">${m.kcal}</span></div>`
  ).join('');

  return `<div class="health-widgets">
    <div class="health-card">
      <div class="health-card-title">💧 Água</div>
      <div class="health-card-value">${waterLabel}</div>
      <div class="health-card-goal">meta: ${goalWater}</div>
      <div class="health-progress"><div class="health-progress-fill water-fill" style="width:${waterPct}%"></div></div>
      <div class="water-btns">
        <button class="water-btn" onclick="addWater(150,'${date}')">+150</button>
        <button class="water-btn" onclick="addWater(250,'${date}')">+250</button>
        <button class="water-btn" onclick="addWater(500,'${date}')">+500</button>
        <button class="water-btn water-btn-edit" onclick="openWaterCustom('${date}')">✎</button>
      </div>
    </div>
    <div class="health-card">
      <div class="health-card-title">🔥 Calorias</div>
      <div class="health-card-value">${totalKcal} <span class="health-card-unit">kcal</span></div>
      <div class="health-card-goal">meta: ${g.calories} kcal</div>
      <div class="health-progress"><div class="health-progress-fill cal-fill${calOver ? ' over' : ''}" style="width:${calPct}%"></div></div>
      ${recentMeals ? `<div class="meal-list">${recentMeals}</div>` : ''}
      <button class="cal-btn" onclick="openAddMeal('${date}')">+ Refeição</button>
    </div>
  </div>`;
}

function addWater(ml, date) {
  const h = DB.getHealth(date);
  h.water = (h.water || 0) + ml;
  DB.setHealth(date, h);
  toast(`+${ml} ml 💧`);
  renderDashboard();
}

function openWaterCustom(date) {
  modalMode = 'water';
  modalContext = { date };
  document.getElementById('modal-title').textContent = 'Adicionar Água';
  document.getElementById('modal-body').innerHTML = `<div class="form-group">
    <label class="form-label">Quantidade (ml)</label>
    <input class="form-input" id="f-water-ml" type="number" inputmode="numeric" placeholder="ex: 330" min="1">
  </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('f-water-ml')?.focus(), 100);
}

function saveWaterCustom() {
  const ml = parseInt(document.getElementById('f-water-ml')?.value);
  if (isNaN(ml) || ml <= 0) { toast('Valor inválido'); return; }
  closeModal();
  addWater(ml, modalContext?.date || isoDate(new Date()));
}

function openAddMeal(date) {
  modalMode = 'meal';
  modalContext = { date };
  const canScan = 'BarcodeDetector' in window;
  document.getElementById('modal-title').textContent = 'Adicionar Refeição';
  document.getElementById('modal-body').innerHTML = `<div class="form-group">
    <label class="form-label">Pesquisar alimento</label>
    <div class="food-search-row">
      <input class="form-input food-search-input" id="f-food-search" type="text"
             placeholder="ex: frango grelhado, arroz…" autocomplete="off"
             oninput="onFoodSearch(this.value)">
      ${canScan ? `<button class="food-scan-btn" onclick="scanBarcode()" title="Ler código de barras">📷</button>` : ''}
    </div>
    <div id="food-results" class="food-results"></div>

    <label class="form-label">Nome da refeição</label>
    <input class="form-input" id="f-meal-name" type="text" placeholder="Nome" autocomplete="off">

    <label class="form-label">Porção e calorias</label>
    <div class="form-row">
      <input class="form-input" id="f-meal-portion" type="number" inputmode="numeric"
             placeholder="Porção (g)" min="1" value="100" oninput="recalcKcal()">
      <input class="form-input" id="f-meal-kcal" type="number" inputmode="numeric"
             placeholder="Calorias (kcal)" min="0">
    </div>
    <input id="f-kcal-100g" type="hidden" value="">
  </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('f-food-search')?.focus(), 100);
}

function saveMeal() {
  const name = document.getElementById('f-meal-name')?.value.trim();
  const kcal = parseInt(document.getElementById('f-meal-kcal')?.value);
  if (!name) { toast('Adiciona o nome da refeição!'); return; }
  if (isNaN(kcal) || kcal < 0) { toast('Calorias inválidas!'); return; }
  const date = modalContext?.date || isoDate(new Date());
  const h = DB.getHealth(date);
  h.meals.push({ id: uid(), name, kcal, time: new Date().toTimeString().slice(0, 5) });
  DB.setHealth(date, h);
  closeModal();
  toast('Refeição adicionada! 🔥');
  renderDashboard();
}

// ---- FOOD SEARCH (Open Food Facts) ----
function onFoodSearch(q) {
  clearTimeout(foodSearchTimer);
  const box = document.getElementById('food-results');
  if (!box) return;
  if (!q || q.length < 2) { box.innerHTML = ''; box.classList.remove('visible'); return; }
  box.innerHTML = '<div class="food-searching">A pesquisar…</div>';
  box.classList.add('visible');
  foodSearchTimer = setTimeout(() => fetchFoodSearch(q), 400);
}

async function fetchFoodSearch(q) {
  const box = document.getElementById('food-results');
  if (!box) return;
  try {
    const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_terms='
      + encodeURIComponent(q)
      + '&search_simple=1&action=process&json=1&fields=product_name,brands,nutriments&page_size=7';
    const res = await fetch(url);
    const data = await res.json();
    const items = (data.products || []).filter(p =>
      p.product_name && p.nutriments?.['energy-kcal_100g'] != null
    ).slice(0, 6);
    if (!items.length) {
      box.innerHTML = '<div class="food-searching">Sem resultados — insere as kcal manualmente.</div>';
      return;
    }
    box.innerHTML = items.map(p => {
      const name = p.product_name;
      const brand = p.brands ? ' · ' + p.brands.split(',')[0].trim() : '';
      const kcal = Math.round(p.nutriments['energy-kcal_100g']);
      return `<div class="food-result-item" data-name="${esc(name)}" data-kcal="${kcal}" onclick="selectFood(this)">
        <span class="food-result-name">${esc(name)}<span class="food-result-brand">${esc(brand)}</span></span>
        <span class="food-result-kcal">${kcal} kcal/100g</span>
      </div>`;
    }).join('');
  } catch {
    box.innerHTML = '<div class="food-searching">Sem ligação — insere as kcal manualmente.</div>';
  }
}

function selectFood(el) {
  const name = el.dataset.name;
  const kcal100 = parseInt(el.dataset.kcal);
  document.getElementById('f-meal-name').value = name;
  document.getElementById('f-food-search').value = name;
  document.getElementById('f-kcal-100g').value = kcal100;
  const portion = parseInt(document.getElementById('f-meal-portion').value) || 100;
  document.getElementById('f-meal-kcal').value = Math.round(kcal100 * portion / 100);
  const box = document.getElementById('food-results');
  box.innerHTML = '';
  box.classList.remove('visible');
}

function recalcKcal() {
  const kcal100 = parseInt(document.getElementById('f-kcal-100g')?.value);
  if (!kcal100) return;
  const portion = parseInt(document.getElementById('f-meal-portion').value) || 100;
  document.getElementById('f-meal-kcal').value = Math.round(kcal100 * portion / 100);
}

async function scanBarcode() {
  if (!('BarcodeDetector' in window)) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      const barcodes = await detector.detect(bitmap);
      if (!barcodes.length) { toast('Código de barras não detectado'); return; }
      toast('A pesquisar produto…');
      await fetchByBarcode(barcodes[0].rawValue);
    } catch { toast('Erro ao ler código de barras'); }
  };
  input.click();
}

async function fetchByBarcode(code) {
  try {
    const res = await fetch('https://world.openfoodfacts.org/api/v0/product/' + code + '.json');
    const data = await res.json();
    if (data.status !== 1) { toast('Produto não encontrado'); return; }
    const p = data.product;
    const kcal100 = Math.round(p.nutriments?.['energy-kcal_100g'] || 0);
    const name = p.product_name_pt || p.product_name || code;
    if (!kcal100) { toast('Produto sem informação nutricional'); return; }
    document.getElementById('f-meal-name').value = name;
    document.getElementById('f-food-search').value = name;
    document.getElementById('f-kcal-100g').value = kcal100;
    const portion = parseInt(document.getElementById('f-meal-portion').value) || 100;
    document.getElementById('f-meal-kcal').value = Math.round(kcal100 * portion / 100);
    const box = document.getElementById('food-results');
    if (box) { box.innerHTML = ''; box.classList.remove('visible'); }
    toast('Produto encontrado!');
  } catch { toast('Erro ao pesquisar produto'); }
}

// ---- WEEK VIEW ----
function renderWeekContent(now, tasks) {
  const todayIdx = now.getDay();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((todayIdx + 6) % 7));

  const days = Array.from({length: 7}, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

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
  days.forEach(d => {
    const isToday = d.toDateString() === now.toDateString();
    html += `<div class="week-day-col">
      <div class="week-day-name">${DAYS_SHORT[d.getDay()]}</div>
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
  return html + '</div>';
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
  renderDashboard();
}

// ---- SETTINGS VIEW ----
// ---- SETTINGS (opens in modal) ----
function openSettings() {
  modalMode = 'settings';
  document.getElementById('modal-title').textContent = 'Definições';
  document.getElementById('btn-save').style.display = 'none';
  document.getElementById('btn-cancel').textContent = 'Fechar';
  document.getElementById('modal-body').innerHTML = renderSettingsContent();
  document.getElementById('modal-overlay').classList.add('open');
}

function renderSettingsContent() {
  const s = DB.getSettings();
  const g = DB.getGoals();
  const goalWater = g.water >= 1000 ? (g.water / 1000) + ' L' : g.water + ' ml';
  return `
    <div class="section" style="margin-top:16px">
      <div class="section-title">Metas diárias</div>
      <div class="card">
        <div class="settings-item" onclick="openGoals()">
          <span class="settings-label">💧 Água</span>
          <span class="settings-value">${goalWater} ›</span>
        </div>
        <div class="settings-item" onclick="openGoals()">
          <span class="settings-label">🔥 Calorias</span>
          <span class="settings-value">${g.calories} kcal ›</span>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Notificações</div>
      <div class="card">
        <div class="settings-item">
          <span class="settings-label">Ativar Notificações</span>
          <button class="toggle${s.notifications ? ' on' : ''}" onclick="toggleNotifs()"></button>
        </div>
        ${'Notification' in window && Notification.permission === 'denied' ? `
        <div class="settings-hint">⚠️ Permissão bloqueada no browser. Vai às definições do browser → este site → Notificações → Permitir.</div>` : ''}
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
        <div class="settings-item" onclick="openStorageDiag()" style="cursor:pointer">
          <span class="settings-label">Recuperar dados antigos</span>
          <span class="settings-value">›</span>
        </div>
        <div class="settings-item" onclick="clearData()" style="cursor:pointer">
          <span class="settings-label" style="color:var(--danger)">Limpar todos os dados</span>
          <span class="settings-value">›</span>
        </div>
      </div>
    </div>`;
}

function openGoals() {
  const g = DB.getGoals();
  modalMode = 'goals';
  document.getElementById('btn-save').style.display = '';
  document.getElementById('btn-cancel').textContent = 'Cancelar';
  document.getElementById('modal-title').textContent = 'Metas diárias';
  document.getElementById('modal-body').innerHTML = `<div class="form-group">
    <label class="form-label">💧 Água (ml)</label>
    <input class="form-input" id="f-goal-water" type="number" inputmode="numeric" value="${g.water}" min="100">
    <label class="form-label">🔥 Calorias (kcal)</label>
    <input class="form-input" id="f-goal-cal" type="number" inputmode="numeric" value="${g.calories}" min="100">
  </div>`;
  setTimeout(() => document.getElementById('f-goal-water')?.focus(), 100);
}

function saveGoals() {
  const water = parseInt(document.getElementById('f-goal-water')?.value);
  const calories = parseInt(document.getElementById('f-goal-cal')?.value);
  if (isNaN(water) || water < 100) { toast('Meta de água inválida'); return; }
  if (isNaN(calories) || calories < 100) { toast('Meta de calorias inválida'); return; }
  DB.setGoals({ water, calories });
  closeModal();
  toast('Metas guardadas!');
  renderDashboard();
}

function openStorageDiag() {
  // collect all localStorage entries
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    let val;
    try { val = JSON.parse(localStorage.getItem(k)); } catch { val = localStorage.getItem(k); }
    entries.push({ k, val });
  }

  // find candidates: arrays of objects that look like tasks
  const candidates = entries.filter(({ val }) => {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      const s = val[0];
      return 'title' in s || 'name' in s || 'task' in s || 'text' in s || 'label' in s;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const arr = val.tasks || val.items || val.list || val.data;
      return Array.isArray(arr) && arr.length > 0;
    }
    return false;
  });

  const keySummary = entries.map(({ k, val }) => {
    const size = Array.isArray(val) ? val.length + ' itens' : typeof val === 'object' ? 'objeto' : String(val).slice(0, 30);
    return `<div class="diag-row"><code>${esc(k)}</code><span>${esc(size)}</span></div>`;
  }).join('') || '<p style="color:var(--muted);padding:12px">Nenhum dado encontrado no browser.</p>';

  const importBtns = candidates.map(({ k, val }) => {
    const arr = Array.isArray(val) ? val : (val.tasks || val.items || val.list || val.data);
    return `<button class="chip" style="margin:4px" onclick="importFromKey('${esc(k)}')">${esc(k)} (${arr.length} itens)</button>`;
  }).join('');

  modalMode = 'diag';
  document.getElementById('btn-save').style.display = 'none';
  document.getElementById('btn-cancel').textContent = 'Fechar';
  document.getElementById('modal-title').textContent = 'Recuperar dados';
  document.getElementById('modal-body').innerHTML = `
    <div class="form-group">
      ${candidates.length ? `
        <p style="font-size:14px;margin-bottom:12px">Encontrei possíveis tarefas nestes dados:</p>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px">${importBtns}</div>
      ` : '<p style="font-size:14px;color:var(--muted);margin-bottom:16px">Não encontrei tarefas de apps anteriores.</p>'}
      <label class="form-label">Todos os dados guardados</label>
      <div class="diag-table">${keySummary}</div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

function importFromKey(key) {
  try {
    let val = JSON.parse(localStorage.getItem(key));
    const arr = Array.isArray(val) ? val : (val.tasks || val.items || val.list || val.data || []);
    if (!arr.length) { toast('Sem dados nesta chave'); return; }
    const migrated = arr.map(t => ({
      id:        t.id || uid(),
      title:     t.title || t.name || t.task || t.text || t.label || 'Tarefa importada',
      category:  t.category || t.cat || 'personal',
      priority:  t.priority || t.pri || 'medium',
      days:      Array.isArray(t.days) ? t.days : [],
      date:      t.date || t.dueDate || '',
      startTime: t.startTime || t.time || t.start || '',
      endTime:   t.endTime || t.end || '',
      completed: !!(t.completed || t.done || t.checked),
      createdAt: t.createdAt || new Date().toISOString(),
      notification: true,
    }));
    const existing = DB.getTasks();
    DB.setTasks([...existing, ...migrated]);
    closeModal();
    renderDashboard();
    toast(`${migrated.length} tarefas importadas! ✅`);
  } catch { toast('Erro ao importar'); }
}

// ---- MODAL ----
function bindModal() {
  document.getElementById('btn-add').addEventListener('click', () => openAdd());
  document.getElementById('btn-save').addEventListener('click', dispatchSave);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
}

function dispatchSave() {
  if (modalMode === 'task')    saveTask();
  else if (modalMode === 'meal')  saveMeal();
  else if (modalMode === 'water') saveWaterCustom();
  else if (modalMode === 'goals') saveGoals();
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
  renderDashboard();
}

function deleteTask(id) {
  if (!confirm('Apagar esta tarefa?')) return;
  DB.setTasks(DB.getTasks().filter(t => t.id !== id));
  cancelTimer(id);
  closeModal();
  renderDashboard();
  toast('Tarefa apagada');
}

function toggleDone(e, id) {
  e.stopPropagation();
  const tasks = DB.getTasks();
  const i = tasks.findIndex(t => t.id === id);
  if (i >= 0) { tasks[i].completed = !tasks[i].completed; DB.setTasks(tasks); renderDashboard(); }
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('btn-save').style.display = '';
  document.getElementById('btn-cancel').textContent = 'Cancelar';
  modalMode = 'task';
  modalContext = null;
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
  if (!('Notification' in window)) {
    toast('Notificações não suportadas neste browser');
    return;
  }
  const s = DB.getSettings();
  if (s.notifications) {
    s.notifications = false;
    DB.setSettings(s);
    Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k]; });
    toast('Notificações desativadas');
  } else {
    if (Notification.permission === 'denied') {
      toast('Permissão bloqueada — activa nas definições do browser');
      if (modalMode === 'settings') {
        document.getElementById('modal-body').innerHTML = renderSettingsContent();
      }
      return;
    }
    const res = await Notification.requestPermission();
    s.notifications = res === 'granted';
    DB.setSettings(s);
    if (res === 'granted') { scheduleAll(); toast('Notificações ativas! 🔔'); }
    else toast('Permissão negada — activa nas definições do browser');
  }
  if (modalMode === 'settings') document.getElementById('modal-body').innerHTML = renderSettingsContent();
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
  const existing = DB.getTasks();
  const r = new FileReader();
  r.onload = ev => {
    try {
      const d = JSON.parse(ev.target.result);
      if (Array.isArray(d.tasks)) {
        if (existing.length > 0 && !confirm(`Importar ${d.tasks.length} tarefas? Os ${existing.length} dados atuais serão substituídos.`)) {
          return;
        }
        DB.setTasks(d.tasks);
        scheduleAll();
        renderDashboard();
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
  renderDashboard();
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
