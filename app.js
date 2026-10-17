'use strict';

// ---------- константы и форматирование ----------

const $ = (id) => document.getElementById(id);
const DAY = 86400e3;
const MSK = 3 * 3600e3; // станции в Йошкар-Оле, МСК без перехода на летнее время
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const SLOTS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const nfc = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const dtf = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const syncFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const CONNECTORS = { GBT_DC: 'GB/T DC', GBT_AC: 'GB/T AC', C_TYPE2: 'Type 2', C_TYPE1: 'Type 1', C_CCS2: 'CCS2', C_CHADEMO: 'CHAdeMO' };
const STEPS = {
  FINISHED_SUCCESS: 'Завершено',
  FINISHED_WITH_ERROR: 'С ошибкой',
  CANCELED: 'Отменено',
  CHARGING: 'Идёт зарядка',
  CABLE_PLUGGED_IN: 'Кабель подключён',
  WAITING_FOR_CABLE_INSERT: 'Ждёт кабель',
  OFFLINE: 'Офлайн',
};
const BAD_STEPS = new Set(['FINISHED_WITH_ERROR', 'CANCELED', 'OFFLINE']);
const INITIATORS = { CUSTOMER: 'Клиент', CHARGING_STATION: 'Станция', USER: 'Оператор', CSMS_BALANCE_EXCEEDED: 'Кончился баланс' };

const METRICS = {
  kwh: { title: 'Энергия по станциям', unit: 'кВт⋅ч', fmt: (v) => nf0.format(v) },
  rub: { title: 'Выручка по станциям', unit: '₽', fmt: (v) => nf0.format(v) },
  count: { title: 'Сессии по станциям', unit: 'сессий', fmt: (v) => nf0.format(v) },
};

const connLabel = (c) => CONNECTORS[c] ?? (c ? c.replace(/^C_/, '').replace(/_/g, ' ') : '—');
const initiatorLabel = (b) => INITIATORS[b] ?? (b ? b.replace(/_/g, ' ').toLowerCase() : '—');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const mskParts = (ms) => {
  const d = new Date(ms + MSK);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: (d.getUTCDay() + 6) % 7, h: d.getUTCHours() };
};
const mskDate = (y, m, d) => Date.UTC(y, m, d) - MSK;
const dayStart = (ms) => {
  const p = mskParts(ms);
  return mskDate(p.y, p.m, p.d);
};
const isoDate = (ms) => {
  const p = mskParts(ms);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};
const parseIsoDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return mskDate(y, m - 1, d);
};
const fmtDuration = (min) => {
  if (min == null) return '—';
  const m = Math.round(min);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// ---------- состояние ----------

const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('itcharge-admin') || '{}');
  } catch {
    return {};
  }
})();

const state = {
  authed: false,
  syncedAt: null,
  stations: [],
  stationById: new Map(),
  rows: [],
  merged: new Map(), // станция → слитые интервалы занятости
  minStart: null,
  selected: new Set(),
  period: prefs.period ?? 30, // число дней | 'all' | 'custom'
  from: null,
  to: null,
  gran: prefs.gran ?? 'auto',
  metric: prefs.metric ?? 'kwh',
  view: 'chart',
  sessionsShown: 30,
};

function savePrefs() {
  try {
    localStorage.setItem('itcharge-admin', JSON.stringify({ period: state.period === 'custom' ? 30 : state.period, gran: state.gran, metric: state.metric }));
  } catch {
    /* приватный режим — просто не запоминаем */
  }
}

// ---------- IT Charge API (напрямую из браузера) ----------

const API = 'https://api.itcharge.ru/graphql/cp';
const TENANT = 'itcharge';
const PAGE_SIZE = 100; // больше API не принимает
const FINAL_STEPS = new Set(['FINISHED_SUCCESS', 'FINISHED_WITH_ERROR', 'CANCELED']);
const TOKEN_KEY = 'itcharge-admin-token';

let memToken = null;
function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken;
  } catch {
    return memToken;
  }
}
function setToken(value) {
  memToken = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* приватный режим — токен живёт до перезагрузки */
  }
}

async function gql(query, variables = {}, token = getToken()) {
  const headers = { 'content-type': 'application/json', tenant: TENANT, 'x-application-version': '2.0.0-admin-panel' };
  if (token) headers.authorization = token;
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const json = await res.json().catch(() => null);
  if (res.status === 401 || json?.errors?.some((e) => e.extensions?.constant === 'UNAUTHORIZED')) {
    const err = new Error('Сессия IT Charge истекла, войдите заново');
    err.auth = true;
    throw err;
  }
  if (!json) throw new Error(`IT Charge API: HTTP ${res.status}`);
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

async function login(email, password) {
  let data;
  try {
    data = await gql(
      `query UserLogin($email: String!, $password: String!, $tenant: String) {
        UserLogin(email: $email, password: $password, tenant: $tenant) { token }
      }`,
      { email, password, tenant: TENANT },
      null,
    );
  } catch (err) {
    throw new Error(`Не удалось войти: ${err.message}`);
  }
  if (!data.UserLogin?.token) throw new Error('Неверный email или пароль');
  setToken(data.UserLogin.token);
}

const TX_FIELDS = `
  seqNo id transactionStep startedTimestamp stoppedTimestamp createdAt updatedAt
  totalKW avgPower maxPower totalDuration idleDuration startedPercentage percentage
  stoppedReason stopInitiator isRoaming
  tariff { type amount name }
  connector { evseId type }
  invoice { amount }
  payment { amount }
  chargingStation { id }
  authorization { company { name } ocpiPlatform { name } }`;

// Телефоны и id клиентов не запрашиваются — для графиков они не нужны.
const compact = (r) => ({
  id: r.id,
  n: r.seqNo,
  step: r.transactionStep,
  start: r.startedTimestamp || r.createdAt,
  stop: r.stoppedTimestamp,
  upd: r.updatedAt,
  kwh: r.totalKW ?? 0,
  avgP: r.avgPower,
  maxP: r.maxPower,
  dur: r.totalDuration,
  idle: r.idleDuration,
  soc0: r.startedPercentage,
  soc1: r.percentage,
  reason: r.stoppedReason,
  by: r.stopInitiator,
  roaming: r.isRoaming,
  rub: r.invoice?.amount ?? r.payment?.amount ?? 0,
  tariff: r.tariff?.name ?? null,
  price: r.tariff?.amount ?? null,
  conn: r.connector?.type ?? null,
  evse: r.connector?.evseId ?? null,
  st: r.chargingStation?.id ?? null,
  via: r.authorization?.ocpiPlatform?.name || r.authorization?.company?.name || null,
});

async function fetchPage(number) {
  const data = await gql(
    `query Tx($page: Page!, $orderBy: [TransactionsListRequestOrderInputType!]) {
      TransactionsList(page: $page, orderBy: $orderBy) { count rows { ${TX_FIELDS} } }
    }`,
    { page: { size: PAGE_SIZE, number }, orderBy: [{ seqNo: 'desc' }] },
  );
  return data.TransactionsList;
}

async function fetchStations() {
  const data = await gql(`query { ChargingStationsList(page: { size: 100, number: 1 }) { rows { id seqNo name address connected } } }`);
  return data.ChargingStationsList.rows;
}

// Кэш в IndexedDB: в localStorage тысячи транзакций не помещаются.
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('itcharge-admin', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => {
        open.result.close();
        resolve(req.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}
const cacheGet = () => idb('readonly', (s) => s.get('data')).catch(() => null);
const cacheSet = (value) => idb('readwrite', (s) => s.put(value, 'data')).catch(() => {});
const cacheClear = () => idb('readwrite', (s) => s.delete('data')).catch(() => {});

// Первая синхронизация тянет всю историю; дальше — страницы сверху,
// пока не встретится страница, где все транзакции уже есть и завершены.
async function sync(onProgress) {
  const cache = await cacheGet();
  const byId = new Map((cache?.rows ?? []).map((r) => [r.id, r]));
  const firstSync = byId.size === 0;

  const upsert = (rows) => {
    let unchanged = 0;
    for (const raw of rows) {
      const row = compact(raw);
      const prev = byId.get(row.id);
      if (prev && prev.upd === row.upd && prev.step === row.step && FINAL_STEPS.has(row.step)) unchanged++;
      byId.set(row.id, row);
    }
    return unchanged === rows.length;
  };

  const stations = await fetchStations();
  const first = await fetchPage(1);
  const pages = Math.ceil(first.count / PAGE_SIZE);
  let done = upsert(first.rows) && !firstSync;

  if (firstSync) {
    let loaded = 1;
    onProgress?.(loaded, pages);
    const queue = Array.from({ length: pages - 1 }, (_, i) => i + 2);
    const worker = async () => {
      while (queue.length) {
        upsert((await fetchPage(queue.shift())).rows);
        onProgress?.(++loaded, pages);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  } else {
    for (let p = 2; p <= pages && !done; p++) done = upsert((await fetchPage(p)).rows);
  }

  const data = { syncedAt: new Date().toISOString(), stations, rows: [...byId.values()].sort((a, b) => b.n - a.n) };
  await cacheSet(data);
  return data;
}

// ---------- экраны ----------

function show(screen) {
  $('login').hidden = screen !== 'login';
  $('loading').hidden = screen !== 'loading';
  $('dash').hidden = screen !== 'dash';
  $('topActions').hidden = screen === 'loading' || (screen === 'login' && !state.rows.length);
}

function updateTop() {
  $('syncBtn').textContent = state.authed ? 'Обновить' : 'Войти';
  $('logoutBtn').hidden = !state.authed;
  $('syncInfo').textContent = state.syncedAt
    ? `Обновлено ${syncFmt.format(new Date(state.syncedAt))} · ${nf0.format(state.rows.length)} транзакций`
    : '';
}

function applyData(data) {
  state.syncedAt = data.syncedAt;
  prepare(data.stations ?? [], data.rows ?? []);
}

let syncing = false;

async function doSync() {
  if (syncing) return;
  syncing = true;
  const firstLoad = !state.rows.length;
  if (firstLoad) {
    $('loadingText').textContent = 'Загружаю историю транзакций…';
    show('loading');
  } else {
    $('dash').classList.add('busy');
  }
  $('syncBtn').disabled = true;
  try {
    applyData(await sync((loaded, total) => ($('loadingText').textContent = `Загружаю историю транзакций: ${loaded} из ${total}…`)));
    show('dash');
    render();
  } catch (err) {
    if (err.auth) {
      setToken(null);
      state.authed = false;
      $('loginError').textContent = err.message;
      show('login');
    } else {
      alert(`Не удалось обновить данные: ${err.message}`);
      if (firstLoad) show('login');
    }
  } finally {
    syncing = false;
    $('dash').classList.remove('busy');
    $('syncBtn').disabled = false;
    updateTop();
  }
}

// ---------- подготовка данных ----------

function prepare(stationList, rows) {
  const known = new Map(stationList.map((s) => [s.id, s]));
  for (const r of rows) {
    if (r.st && !known.has(r.st)) known.set(r.st, { id: r.st, name: `Станция ${r.st.slice(0, 8)}`, seqNo: Infinity, connected: false });
  }
  // Цвет закреплён за станцией: сначала подключённые, затем по номеру — не по рангу.
  const list = [...known.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || a.seqNo - b.seqNo);
  const words = list.map((s) => s.name.split(/\s+/));
  let common = 0;
  while (list.length > 1 && words.every((w) => w.length > common + 1 && w[common] === words[0][common])) common++;
  state.stations = list.map((s, i) => ({ ...s, short: words[i].slice(common).join(' '), slot: SLOTS[Math.min(i, SLOTS.length - 1)] }));
  state.stationById = new Map(state.stations.map((s) => [s.id, s]));

  const now = Date.now();
  state.rows = rows.map((r) => {
    const t = Date.parse(r.start);
    let te = r.stop ? Date.parse(r.stop) : r.dur ? t + r.dur * 60e3 : t;
    if (!r.stop && (r.step === 'CHARGING' || r.step === 'CABLE_PLUGGED_IN')) te = now;
    return { ...r, t, te };
  });
  state.minStart = state.rows.reduce((min, r) => Math.min(min, r.t), Infinity);

  state.merged = new Map();
  for (const s of state.stations) {
    const iv = state.rows
      .filter((r) => r.st === s.id && r.step !== 'CANCELED' && r.te > r.t)
      .map((r) => [r.t, r.te])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [a, b] of iv) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    state.merged.set(s.id, merged);
  }

  if (!state.selected.size) state.stations.forEach((s) => state.selected.add(s.id));
  renderChips();
}

function currentRange() {
  const now = Date.now();
  if (state.period === 'custom') return { from: state.from, to: Math.min(state.to, now) };
  if (state.period === 'all') return { from: dayStart(Number.isFinite(state.minStart) ? state.minStart : now), to: now };
  return { from: dayStart(now) - (state.period - 1) * DAY, to: now };
}

function resolveGran(from, to) {
  if (state.gran !== 'auto') return state.gran;
  const days = (to - from) / DAY;
  return days <= 45 ? 'day' : days <= 210 ? 'week' : 'month';
}

function bucketStart(ms, gran) {
  const p = mskParts(ms);
  if (gran === 'day') return mskDate(p.y, p.m, p.d);
  if (gran === 'week') return mskDate(p.y, p.m, p.d - p.dow);
  return mskDate(p.y, p.m, 1);
}

function nextBucket(ms, gran) {
  if (gran === 'day') return ms + DAY;
  if (gran === 'week') return ms + 7 * DAY;
  const p = mskParts(ms);
  return mskDate(p.y, p.m + 1, 1);
}

function bucketLabel(ms, gran) {
  const p = mskParts(ms);
  return gran === 'month' ? `${MONTHS[p.m]} ${p.y}` : `${p.d} ${MONTHS[p.m]}`;
}

function bucketTitle(ms, gran) {
  const p = mskParts(ms);
  if (gran === 'month') return `${MONTHS_FULL[p.m]} ${p.y}`;
  if (gran === 'week') {
    const e = mskParts(ms + 6 * DAY);
    return e.m === p.m ? `${p.d}–${e.d} ${MONTHS[p.m]} ${e.y}` : `${p.d} ${MONTHS[p.m]} – ${e.d} ${MONTHS[e.m]} ${e.y}`;
  }
  return `${WEEKDAYS[p.dow]}, ${p.d} ${MONTHS[p.m]} ${p.y}`;
}

// Доля времени [from, to), когда станция была занята, по корзинам и в целом.
function occupancy(stationId, from, to, buckets, gran) {
  const busy = new Array(buckets.length).fill(0);
  let total = 0;
  for (const [a0, b0] of state.merged.get(stationId) ?? []) {
    const a = Math.max(a0, from);
    const b = Math.min(b0, to);
    if (b <= a) continue;
    total += b - a;
    for (let i = 0; i < buckets.length; i++) {
      const bs = Math.max(buckets[i], from);
      const be = Math.min(nextBucket(buckets[i], gran), to);
      if (be <= a) continue;
      if (bs >= b) break;
      busy[i] += Math.min(b, be) - Math.max(a, bs);
    }
  }
  // Вне срока работы станции (до первой и после последней сессии) — разрыв, а не ноль.
  const merged = state.merged.get(stationId) ?? [];
  const working = state.stationById.get(stationId)?.connected;
  const life = merged.length ? [merged[0][0], working ? Infinity : merged[merged.length - 1][1]] : null;
  const perBucket = busy.map((v, i) => {
    const bs = Math.max(buckets[i], from);
    const be = Math.min(nextBucket(buckets[i], gran), to);
    if (!life || be <= dayStart(life[0]) || bs >= life[1] + DAY) return null;
    return be > bs ? (v / (be - bs)) * 100 : 0;
  });
  return { perBucket, total: to > from ? (total / (to - from)) * 100 : 0 };
}

function computeView() {
  const { from, to } = currentRange();
  const gran = resolveGran(from, to);
  const buckets = [];
  for (let b = bucketStart(from, gran); b < to; b = nextBucket(b, gran)) buckets.push(b);

  const rows = state.rows.filter((r) => state.selected.has(r.st) && r.t >= from && r.t < to);
  const charged = rows.filter((r) => r.kwh > 0);
  const series = state.stations.filter((s) => state.selected.has(s.id) && rows.some((r) => r.st === s.id));

  const len = to - from;
  const prevRows = state.period === 'all' ? null : state.rows.filter((r) => state.selected.has(r.st) && r.t >= from - len && r.t < from && r.kwh > 0);

  return { from, to, gran, buckets, rows, charged, series, prevRows };
}

// ---------- отрисовка ----------

const charts = {};

function render() {
  if ($('dash').hidden) return;
  const v = computeView();
  syncControls(v);
  renderKpis(v);
  renderMain(v);
  renderUtil(v);
  renderHeatmap(v);
  renderHist(v);
  renderStationTable(v);
  renderSessions(v);
}

function syncControls(v) {
  for (const b of $('periodSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(String(state.period) === b.dataset.days));
  for (const b of $('granSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(state.gran === b.dataset.gran));
  for (const b of $('metricSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(state.metric === b.dataset.metric));
  for (const b of $('viewSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(state.view === b.dataset.view));
  $('fromDate').value = isoDate(v.from);
  $('toDate').value = isoDate(v.to - 1);
}

function renderChips() {
  const box = $('stationChips');
  box.replaceChildren(
    ...state.stations.map((s) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(state.selected.has(s.id)),
          title: s.address ? `${s.name}\n${s.address}` : s.name,
          onclick: () => {
            if (state.selected.has(s.id)) state.selected.delete(s.id);
            else state.selected.add(s.id);
            renderChips();
            render();
          },
        },
        h('span', { class: 'sw', style: { background: css(s.slot) } }),
        s.short,
      ),
    ),
  );
}

function sums(rows) {
  const kwh = rows.reduce((a, r) => a + r.kwh, 0);
  const rub = rows.reduce((a, r) => a + (r.rub || 0), 0);
  const dur = rows.reduce((a, r) => a + (r.dur || 0), 0);
  return { count: rows.length, kwh, rub, avgKwh: rows.length ? kwh / rows.length : 0, avgDur: rows.length ? dur / rows.length : 0, price: kwh ? rub / kwh : 0 };
}

function renderKpis(v) {
  const cur = sums(v.charged);
  const prev = v.prevRows ? sums(v.prevRows) : null;
  const noEnergy = v.rows.length - v.charged.length;

  const tile = ({ label, value, unit, key, hero, upGood = true, note }) => {
    let delta = null;
    if (prev && prev[key] > 0) {
      const d = (cur[key] - prev[key]) / prev[key];
      const dir = Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down';
      const tone = upGood === null || dir === 'flat' ? '' : (dir === 'up') === upGood ? 'up' : 'down';
      delta = h('div', { class: `delta ${tone}` }, `${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•'} ${nf0.format(Math.abs(d) * 100)} %`, h('span', { class: 'vs' }, ' к прошлому периоду'));
    } else if (note) {
      delta = h('div', { class: 'delta' }, note);
    }
    return h('div', { class: `tile${hero ? ' hero' : ''}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value, h('span', { class: 'unit' }, unit)), delta);
  };

  $('kpis').replaceChildren(
    tile({ label: 'Отпущено энергии', value: nf0.format(cur.kwh), unit: 'кВт⋅ч', key: 'kwh', hero: true }),
    tile({ label: 'Выручка', value: nf0.format(cur.rub), unit: '₽', key: 'rub' }),
    tile({ label: 'Сессии', value: nf0.format(cur.count), unit: '', key: 'count', note: noEnergy ? `ещё ${nf0.format(noEnergy)} без энергии` : null }),
    tile({ label: 'Средняя сессия', value: nf1.format(cur.avgKwh), unit: 'кВт⋅ч', key: 'avgKwh', upGood: null }),
    tile({ label: 'Среднее время', value: nf0.format(cur.avgDur), unit: 'мин', key: 'avgDur', upGood: null }),
    tile({ label: 'Средняя цена', value: nf1.format(cur.price), unit: '₽/кВт⋅ч', key: 'price', upGood: null }),
  );
}

// Общие настройки Chart.js под токены темы.
function chartTheme() {
  return { surface: css('--surface'), text: css('--text'), text2: css('--text-2'), muted: css('--muted'), grid: css('--grid'), axis: css('--axis'), border: css('--border') };
}

function baseOptions(t, { yFormat, legend = true, line = false, titleFor, footer }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4 } },
    plugins: {
      legend: {
        display: legend,
        position: 'top',
        align: 'start',
        onClick: () => {},
        labels: {
          color: t.text2,
          boxWidth: line ? 18 : 10,
          boxHeight: line ? 2 : 10,
          padding: 14,
          generateLabels: (chart) =>
            chart.data.datasets.map((ds, i) => ({ text: ds.label, fillStyle: ds.seriesColor, strokeStyle: ds.seriesColor, lineWidth: 0, fontColor: t.text2, datasetIndex: i })),
        },
      },
      tooltip: {
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        cornerRadius: 8,
        padding: 10,
        titleColor: t.text2,
        titleFont: { weight: '500' },
        bodyColor: t.text,
        bodyFont: { weight: '600' },
        footerColor: t.text2,
        footerFont: { weight: '500' },
        boxWidth: 12,
        boxHeight: 3,
        boxPadding: 6,
        // Нулевые и пустые значения (например, демонтированной станции) не засоряют подсказку.
        filter: (item) => item.parsed.y != null && (item.parsed.y !== 0 || item.chart.data.datasets.length === 1),
        callbacks: {
          title: (items) => (items.length && titleFor ? titleFor(items[0].dataIndex) : ''),
          label: (ctx) => `${yFormat(ctx.parsed.y)}  ${ctx.dataset.label}`,
          labelColor: (ctx) => ({ borderColor: ctx.dataset.seriesColor, backgroundColor: ctx.dataset.seriesColor, borderWidth: 0, borderRadius: 1.5 }),
          footer: footer ?? (() => ''),
        },
      },
    },
    scales: {
      x: {
        stacked: !line,
        grid: { display: false },
        border: { color: t.axis },
        ticks: { color: t.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 14 },
      },
      y: {
        stacked: !line,
        beginAtZero: true,
        grid: { color: t.grid },
        border: { display: false },
        ticks: { color: t.muted, maxTicksLimit: 6, callback: (val) => yFormat(val, true) },
      },
    },
  };
}

const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = css('--axis');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(active[0].element.x) + 0.5, chartArea.top);
    ctx.lineTo(Math.round(active[0].element.x) + 0.5, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function drawChart(key, canvasId, config) {
  charts[key]?.destroy();
  charts[key] = new Chart($(canvasId), config);
}

// Сложенные столбцы: 2px зазор между сегментами, скругление 4px только у верхнего.
function stackedBarDatasets(series, values, surface) {
  const n = values[0]?.length ?? 0;
  const top = Array.from({ length: n }, (_, i) => {
    for (let s = values.length - 1; s >= 0; s--) if (values[s][i] > 0) return s;
    return -1;
  });
  return series.map((s, si) => {
    const color = css(s.slot);
    return {
      label: s.short,
      data: values[si],
      seriesColor: color,
      backgroundColor: color,
      hoverBackgroundColor: `${color}cc`,
      borderColor: surface,
      borderSkipped: 'start',
      maxBarThickness: 24,
      categoryPercentage: 0.8,
      barPercentage: 0.9,
      borderWidth: (ctx) => (ctx.datasetIndex === top[ctx.dataIndex] ? 0 : { top: 2, right: 0, bottom: 0, left: 0 }),
      borderRadius: (ctx) => (ctx.datasetIndex === top[ctx.dataIndex] ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : 0),
    };
  });
}

function aggregate(v) {
  const index = new Map(v.buckets.map((b, i) => [b, i]));
  const sIndex = new Map(v.series.map((s, i) => [s.id, i]));
  const blank = () => v.series.map(() => new Array(v.buckets.length).fill(0));
  const agg = { kwh: blank(), rub: blank(), count: blank() };
  for (const r of v.charged) {
    const i = index.get(bucketStart(r.t, v.gran));
    const s = sIndex.get(r.st);
    if (i === undefined || s === undefined) continue;
    agg.kwh[s][i] += r.kwh;
    agg.rub[s][i] += r.rub || 0;
    agg.count[s][i] += 1;
  }
  return agg;
}

function renderMain(v) {
  const metric = METRICS[state.metric];
  const values = aggregate(v)[state.metric];
  const granName = { day: 'По дням', week: 'По неделям', month: 'По месяцам' }[v.gran];
  $('mainTitle').textContent = metric.title;
  $('mainSub').textContent = `${granName} · ${bucketTitle(v.from, 'day').replace(/^.., /, '')} — ${bucketTitle(v.to - 1, 'day').replace(/^.., /, '')}`;

  $('mainChartBox').hidden = state.view !== 'chart';
  $('mainTableBox').hidden = state.view !== 'table';

  if (state.view === 'table') {
    charts.main?.destroy();
    delete charts.main;
    const total = (i) => values.reduce((a, s) => a + s[i], 0);
    const head = h('tr', {}, h('th', {}, 'Период'), v.series.map((s) => h('th', {}, s.short)), h('th', {}, 'Итого'));
    const body = v.buckets
      .map((b, i) => h('tr', {}, h('td', {}, bucketTitle(b, v.gran)), v.series.map((_, si) => h('td', {}, metric.fmt(values[si][i]))), h('td', {}, metric.fmt(total(i)))))
      .reverse();
    $('mainTableBox').replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, body)));
    return;
  }

  const t = chartTheme();
  const yFormat = (val, axis) => (axis ? nfc.format(val) : `${metric.fmt(val)} ${metric.unit}`);
  drawChart('main', 'mainChart', {
    type: 'bar',
    data: { labels: v.buckets.map((b) => bucketLabel(b, v.gran)), datasets: stackedBarDatasets(v.series, values, t.surface) },
    options: baseOptions(t, {
      yFormat,
      legend: v.series.length > 1,
      titleFor: (i) => bucketTitle(v.buckets[i], v.gran),
      footer: (items) => (items.length > 1 ? `Всего: ${yFormat(items.reduce((a, it) => a + it.parsed.y, 0))}` : ''),
    }),
  });
}

function renderUtil(v) {
  const t = chartTheme();
  const datasets = v.series.map((s) => {
    const color = css(s.slot);
    return {
      label: s.short,
      data: occupancy(s.id, v.from, v.to, v.buckets, v.gran).perBucket,
      seriesColor: color,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      borderJoinStyle: 'round',
      borderCapStyle: 'round',
      pointRadius: v.buckets.length === 1 ? 4 : 0,
      pointHoverRadius: 5,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: t.surface,
      pointHitRadius: 12,
      tension: 0,
    };
  });
  const yFormat = (val, axis) => (axis ? `${nf0.format(val)} %` : `${nf1.format(val)} %`);
  drawChart('util', 'utilChart', {
    type: 'line',
    data: { labels: v.buckets.map((b) => bucketLabel(b, v.gran)), datasets },
    options: baseOptions(t, { yFormat, line: true, legend: datasets.length > 1, titleFor: (i) => bucketTitle(v.buckets[i], v.gran) }),
    plugins: [crosshair],
  });
}

function renderHeatmap(v) {
  const counts = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of v.charged) {
    const p = mskParts(r.t);
    counts[p.dow][p.h]++;
  }
  const max = Math.max(1, ...counts.flat());
  const levels = 7;
  const cells = [h('div')];
  for (let hr = 0; hr < 24; hr++) cells.push(h('div', { class: 'hlabel' }, hr % 3 === 0 ? hr : ''));
  counts.forEach((row, d) => {
    cells.push(h('div', { class: 'dlabel' }, WEEKDAYS[d]));
    row.forEach((n, hr) => {
      const level = n ? Math.min(levels - 1, Math.floor((n / max) * levels)) : -1;
      const label = `${WEEKDAYS[d]}, ${String(hr).padStart(2, '0')}:00–${String(hr + 1).padStart(2, '0')}:00`;
      cells.push(
        h('div', {
          class: 'cell',
          tabindex: '0',
          'aria-label': `${label}: ${n} сессий`,
          'data-value': `${nf0.format(n)} ${plural(n, 'сессия', 'сессии', 'сессий')}`,
          'data-label': label,
          style: level >= 0 ? { background: `var(--heat-${level})` } : {},
        }),
      );
    });
  });
  const legend = h(
    'div',
    { class: 'heat-legend' },
    h('span', {}, 'реже'),
    h('div', { class: 'ramp' }, Array.from({ length: levels }, (_, i) => h('span', { style: { background: `var(--heat-${i})` } }))),
    h('span', {}, `чаще (до ${max} за час)`),
  );
  $('heatmap').replaceChildren(...cells, legend);
}

function renderHist(v) {
  const t = chartTheme();
  const step = 5;
  const cap = 60;
  const bins = new Array(cap / step + 1).fill(0);
  for (const r of v.charged) bins[Math.min(bins.length - 1, Math.floor(r.kwh / step))]++;
  const labels = bins.map((_, i) => (i === bins.length - 1 ? `${cap}+` : `${i * step}–${(i + 1) * step}`));
  const color = css('--s1');
  const yFormat = (val, axis) => (axis ? nfc.format(val) : `${nf0.format(val)} ${plural(val, 'сессия', 'сессии', 'сессий')}`);
  const options = baseOptions(t, { yFormat, legend: false, titleFor: (i) => `${labels[i]} кВт⋅ч` });
  options.scales.x.title = { display: true, text: 'кВт⋅ч за сессию', color: t.muted };
  drawChart('hist', 'histChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Сессии', data: bins, seriesColor: color, backgroundColor: color, hoverBackgroundColor: `${color}cc`, maxBarThickness: 24, borderSkipped: 'start', borderRadius: { topLeft: 4, topRight: 4 } }],
    },
    options,
  });
}

function renderStationTable(v) {
  const totalKwh = v.charged.reduce((a, r) => a + r.kwh, 0);
  const rows = v.series.map((s) => {
    const own = sums(v.charged.filter((r) => r.st === s.id));
    const occ = occupancy(s.id, v.from, v.to, [], v.gran).total;
    return h(
      'tr',
      {},
      h('td', {}, h('span', { class: 'name-cell', title: s.name }, h('span', { class: 'sw', style: { background: css(s.slot) } }), s.short)),
      h('td', {}, nf0.format(own.count)),
      h('td', {}, nf0.format(own.kwh)),
      h('td', {}, nf0.format(own.rub)),
      h('td', {}, nf1.format(own.avgKwh)),
      h('td', {}, fmtDuration(own.avgDur)),
      h('td', {}, `${nf1.format(occ)} %`),
      h('td', {}, totalKwh ? `${nf0.format((own.kwh / totalKwh) * 100)} %` : '—'),
    );
  });
  const all = sums(v.charged);
  const head = h('tr', {}, ['Станция', 'Сессии', 'кВт⋅ч', '₽', 'Ср. сессия', 'Ср. время', 'Загрузка', 'Доля'].map((c) => h('th', {}, c)));
  const foot = v.series.length > 1
    ? h('tr', {}, h('td', {}, 'Итого'), h('td', {}, nf0.format(all.count)), h('td', {}, nf0.format(all.kwh)), h('td', {}, nf0.format(all.rub)), h('td', {}, nf1.format(all.avgKwh)), h('td', {}, fmtDuration(all.avgDur)), h('td'), h('td'))
    : null;
  $('stationTable').replaceChildren(
    v.series.length ? h('table', {}, h('thead', {}, head), h('tbody', {}, rows), foot && h('tfoot', {}, foot)) : h('p', { class: 'muted' }, 'Нет сессий за выбранный период'),
  );
}

function renderSessions(v) {
  const list = [...v.rows].sort((a, b) => b.t - a.t);
  const shown = list.slice(0, state.sessionsShown);
  $('sessionsSub').textContent = `${nf0.format(list.length)} за период, сначала новые`;
  const head = h('tr', {}, ['Начало', 'Станция', 'Разъём', 'кВт⋅ч', 'Время', 'Ср. / макс. кВт', 'Батарея', '₽', 'Тариф', 'Статус', 'Остановил'].map((c, i) => h('th', { class: [1, 2, 8, 9, 10].includes(i) ? 'left' : '' }, c)));
  const body = shown.map((r) => {
    const s = state.stationById.get(r.st);
    const bad = BAD_STEPS.has(r.step);
    return h(
      'tr',
      {},
      h('td', {}, dtf.format(new Date(r.t))),
      h('td', { class: 'left' }, s ? h('span', { class: 'name-cell' }, h('span', { class: 'sw', style: { background: css(s.slot) } }), s.short) : '—'),
      h('td', { class: 'left' }, connLabel(r.conn)),
      h('td', {}, nf1.format(r.kwh)),
      h('td', {}, fmtDuration(r.dur)),
      h('td', {}, r.avgP != null ? `${nf1.format(r.avgP)} / ${nf1.format(r.maxP ?? 0)}` : '—'),
      h('td', {}, r.soc0 != null ? `${r.soc0} → ${r.soc1 ?? '—'} %` : '—'),
      h('td', {}, r.rub ? nf1.format(r.rub) : '—'),
      h('td', { class: 'left' }, r.tariff ?? '—'),
      h('td', { class: 'left' }, h('span', { class: `status${bad ? ' bad' : ''}` }, bad ? '✕ ' : '', STEPS[r.step] ?? r.step ?? '—')),
      h('td', { class: 'left' }, initiatorLabel(r.by)),
    );
  });
  $('sessionsTable').replaceChildren(list.length ? h('table', {}, h('thead', {}, head), h('tbody', {}, body)) : h('p', { class: 'muted' }, 'Нет сессий за выбранный период'));
  $('moreBtn').hidden = shown.length >= list.length;
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

// ---------- подсказка тепловой карты ----------

function showTip(cell, x, y) {
  const tip = $('tooltip');
  tip.replaceChildren(h('strong', {}, cell.dataset.value), h('span', {}, cell.dataset.label));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, x + 12)}px`;
  tip.style.top = `${Math.max(8, y - r.height - 10)}px`;
}

$('heatmap').addEventListener('pointermove', (e) => {
  const cell = e.target.closest('.cell');
  if (cell) showTip(cell, e.clientX, e.clientY);
  else $('tooltip').hidden = true;
});
$('heatmap').addEventListener('pointerleave', () => ($('tooltip').hidden = true));
$('heatmap').addEventListener('focusin', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const r = cell.getBoundingClientRect();
  showTip(cell, r.right, r.top);
});
$('heatmap').addEventListener('focusout', () => ($('tooltip').hidden = true));

// ---------- события ----------

function bindSeg(id, attr, apply) {
  const seg = $(id);
  for (const b of seg.querySelectorAll('button')) b.setAttribute('role', 'radio');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    apply(b.dataset[attr]);
    savePrefs();
    render();
  });
}

bindSeg('periodSeg', 'days', (val) => {
  state.period = val === 'all' ? 'all' : Number(val);
  state.sessionsShown = 30;
});
bindSeg('granSeg', 'gran', (val) => (state.gran = val));
bindSeg('metricSeg', 'metric', (val) => (state.metric = val));
bindSeg('viewSeg', 'view', (val) => (state.view = val));

for (const id of ['fromDate', 'toDate']) {
  $(id).addEventListener('change', () => {
    if (!$('fromDate').value || !$('toDate').value) return;
    let a = parseIsoDate($('fromDate').value);
    let b = parseIsoDate($('toDate').value);
    if (a > b) [a, b] = [b, a];
    state.period = 'custom';
    state.from = a;
    state.to = b + DAY;
    state.sessionsShown = 30;
    render();
  });
}

$('moreBtn').addEventListener('click', () => {
  state.sessionsShown += 50;
  renderSessions(computeView());
});

$('syncBtn').addEventListener('click', () => {
  if (state.authed) doSync();
  else {
    $('loginError').textContent = '';
    show('login');
  }
});

$('logoutBtn').addEventListener('click', async () => {
  setToken(null);
  await cacheClear();
  state.authed = false;
  state.rows = [];
  state.syncedAt = null;
  for (const key of Object.keys(charts)) {
    charts[key].destroy();
    delete charts[key];
  }
  $('loginError').textContent = '';
  show('login');
  updateTop();
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('button');
  const fd = new FormData(form);
  button.disabled = true;
  $('loginError').textContent = '';
  try {
    await login(String(fd.get('email')).trim(), String(fd.get('password')));
    form.reset();
    state.authed = true;
    updateTop();
    await doSync();
  } catch (err) {
    $('loginError').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  renderChips();
  render();
});

// ---------- старт ----------

(async function boot() {
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 12;
  state.authed = Boolean(getToken());
  const cached = await cacheGet();
  if (cached?.rows?.length) {
    applyData(cached);
    show('dash');
    render();
    updateTop();
    if (state.authed) doSync(); // тихо подтянуть новые транзакции
  } else if (state.authed) {
    updateTop();
    await doSync();
  } else {
    show('login');
  }
})();
