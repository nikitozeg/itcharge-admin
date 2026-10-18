// Логика уведомлений в Telegram-канал по станциям IT Charge: итог каждой завершённой
// зарядки, обрыв и восстановление связи станций, суточный итог в 22:00 МСК.
// Модуль без зависимостей от окружения: состояние и токен приходят и возвращаются
// через check(), хранит их вызывающая сторона (Cloudflare Worker, worker/index.mjs).

const API = 'https://api.itcharge.ru/graphql/cp';
const TENANT = 'itcharge';
const FINISHED = new Set(['FINISHED_SUCCESS', 'FINISHED_WITH_ERROR', 'CANCELED']);
const PAGE_SIZE = 50; // столько последних транзакций проверяем за запуск
const KEEP_IDS = 300;
const OFFLINE_GRACE_MIN = 5; // короткие переподключения станции тревогу не поднимают
const DAILY_HOUR_MSK = 22; // суточный итог: с 22:00 вчера до 22:00 сегодня по Москве
const MSK = 3 * 3600e3; // МСК без перехода на летнее время
const DAY = 86400e3;

const CONNECTORS = { GBT_DC: 'GB/T DC', GBT_AC: 'GB/T AC', C_TYPE2: 'Type 2', C_TYPE1: 'Type 1', C_CCS2: 'CCS2', C_CHADEMO: 'CHAdeMO' };
const INITIATORS = { CUSTOMER: 'клиент', CHARGING_STATION: 'станция', USER: 'оператор', CSMS_BALANCE_EXCEEDED: 'кончился баланс' };

const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDuration = (min) => {
  const m = Math.round(min ?? 0);
  if (m < 60) return `${m} мин`;
  if (m < 1440) return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
  return `${Math.floor(m / 1440)} д ${Math.floor((m % 1440) / 60)} ч`;
};
const fmtWhen = (date) => `${dateFmt.format(date)}, ${timeFmt.format(date)}`;
const plural = (n, one, few, many) => {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
};

export const TX_FIELDS = `
  seqNo id transactionStep startedTimestamp stoppedTimestamp totalKW avgPower maxPower
  totalDuration idleDuration startedPercentage percentage stopInitiator
  tariff { type amount name }
  connector { evseId type }
  invoice { amount }
  payment { amount }
  chargingStation { name }`;

// Текст сообщения (HTML-разметка Telegram). Данных клиента в нём нет.
export function formatMessage(t, { test = false } = {}) {
  const kwh = t.totalKW ?? 0;
  const rub = t.invoice?.amount ?? t.payment?.amount ?? 0;
  const conn = CONNECTORS[t.connector?.type] ?? t.connector?.type?.replace(/^C_/, '').replace(/_/g, ' ') ?? '';
  const start = t.startedTimestamp ? new Date(t.startedTimestamp) : null;
  const stop = t.stoppedTimestamp ? new Date(t.stoppedTimestamp) : null;
  const icon = t.transactionStep === 'FINISHED_SUCCESS' ? '⚡' : '⚠️';
  const status = t.transactionStep === 'FINISHED_WITH_ERROR' ? ' · завершена с ошибкой' : t.transactionStep === 'CANCELED' ? ' · отменена' : '';

  const lines = [];
  if (test) lines.push('🧪 <i>Тестовое сообщение — последняя завершённая зарядка</i>');
  lines.push(`${icon} <b>${esc(t.chargingStation?.name ?? 'Станция')}</b>${conn ? ` · ${esc(conn)}` : ''}${status}`);

  const battery = t.startedPercentage != null && t.percentage != null ? ` · батарея ${t.startedPercentage}% → ${t.percentage}%` : '';
  lines.push(`🔋 <b>${nf2.format(kwh)} кВт⋅ч</b>${battery}`);

  const price = t.tariff?.type === 'PER_KW' && t.tariff?.amount ? ` (${nf2.format(t.tariff.amount)} ₽/кВт⋅ч)` : '';
  if (rub || t.tariff?.name) lines.push(`💰 <b>${nf2.format(rub)} ₽</b>${t.tariff?.name ? ` · ${esc(t.tariff.name)}${price}` : ''}`);

  if (start) {
    const when = `${dateFmt.format(start)}, ${timeFmt.format(start)}${stop ? `–${timeFmt.format(stop)}` : ''}`;
    lines.push(`⏱ ${when} · ${fmtDuration(t.totalDuration)}`);
  }
  const power = [t.avgPower != null && `ср. ${nf1.format(t.avgPower)}`, t.maxPower != null && `макс. ${nf1.format(t.maxPower)}`].filter(Boolean);
  if (power.length) lines.push(`📈 ${power.join(' · ')} кВт`);
  if (t.idleDuration > 0.5) lines.push(`🅿️ простой после зарядки ${fmtDuration(t.idleDuration)}`);
  if (t.stopInitiator) lines.push(`Остановил: ${esc(INITIATORS[t.stopInitiator] ?? t.stopInitiator.replace(/_/g, ' ').toLowerCase())}`);
  return lines.join('\n');
}

// Какие транзакции публиковать. Номера идут по старту, а заканчиваются зарядки
// в другом порядке (на станции несколько разъёмов), поэтому помним id, а не «последний номер».
export function pickNew(rows, state) {
  const notified = new Set(state.notified);
  return rows
    .filter((r) => r.seqNo > state.floor && FINISHED.has(r.transactionStep) && !notified.has(r.id))
    .filter((r) => !(r.transactionStep === 'CANCELED' && !(r.totalKW > 0)))
    .sort((a, b) => Date.parse(a.stoppedTimestamp ?? 0) - Date.parse(b.stoppedTimestamp ?? 0));
}

// Первый запуск: всё уже завершённое считаем опубликованным, идущие зарядки — дождёмся.
export function initState(rows) {
  return {
    floor: rows.length ? Math.min(...rows.map((r) => r.seqNo)) - 1 : 0,
    notified: rows.filter((r) => FINISHED.has(r.transactionStep)).map((r) => r.id),
  };
}

export const STATION_FIELDS = 'id name connected archived disconnectedAt lastConnectionStatusChangedAt';

export function formatOffline(s, since, now) {
  return [`🔴 <b>${esc(s.name)}</b> — нет связи`, `С ${fmtWhen(since)} · уже ${fmtDuration((now - since) / 60e3)}`].join('\n');
}

export function formatOnline(s, since, back) {
  const range = since ? ` (${fmtWhen(since)} – ${timeFmt.format(back)})` : '';
  return [`🟢 <b>${esc(s.name)}</b> — снова на связи`, since ? `Связи не было ${fmtDuration((back - since) / 60e3)}${range}` : ''].filter(Boolean).join('\n');
}

// Сообщения о связи станций. Тревога — если станции нет на связи дольше OFFLINE_GRACE_MIN,
// «снова на связи» — только после отправленной тревоги. Демонтированные (archived) пропускаем.
// apply() меняет состояние и вызывается только после успешной отправки.
export function stationEvents(stations, state, now = Date.now()) {
  state.stations ??= {};
  const events = [];
  for (const s of stations) {
    if (s.archived) continue;
    const prev = state.stations[s.id] ?? { alerted: false, offlineSince: null };
    if (!s.connected) {
      const since = Date.parse(s.disconnectedAt ?? s.lastConnectionStatusChangedAt ?? '') || now;
      if (!prev.alerted && now - since >= OFFLINE_GRACE_MIN * 60e3) {
        events.push({ text: formatOffline(s, since, now), apply: () => (state.stations[s.id] = { alerted: true, offlineSince: new Date(since).toISOString() }) });
      }
    } else if (prev.alerted) {
      const since = prev.offlineSince ? Date.parse(prev.offlineSince) : null;
      const changed = Date.parse(s.lastConnectionStatusChangedAt ?? '');
      const back = changed && (!since || changed >= since) ? changed : now;
      events.push({ text: formatOnline(s, since, back), apply: () => (state.stations[s.id] = { alerted: false, offlineSince: null }) });
    }
  }
  return events;
}

// Конец последних отчётных суток — ближайшие прошедшие 22:00 МСК.
export function lastDailyEnd(now) {
  const d = new Date(now + MSK);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DAILY_HOUR_MSK) - MSK;
  return end > now ? end - DAY : end;
}
export const dailyKey = (end) => new Date(end + MSK).toISOString().slice(0, 10);

// Итог за сутки [start, end): зарядка относится к суткам, в которые закончилась.
export function formatDaily(rows, start, end) {
  const byStation = new Map();
  for (const r of rows) {
    const stop = Date.parse(r.stoppedTimestamp ?? '');
    if (!FINISHED.has(r.transactionStep) || !(stop >= start && stop < end)) continue;
    const name = r.chargingStation?.name ?? 'Станция';
    const acc = byStation.get(name) ?? { rub: 0, kwh: 0, count: 0 };
    acc.rub += r.invoice?.amount ?? r.payment?.amount ?? 0;
    acc.kwh += r.totalKW ?? 0;
    if (r.totalKW > 0) acc.count++;
    byStation.set(name, acc);
  }
  const total = [...byStation.values()].reduce((a, s) => ({ rub: a.rub + s.rub, kwh: a.kwh + s.kwh, count: a.count + s.count }), { rub: 0, kwh: 0, count: 0 });
  const period = `${dateFmt.format(start)} ${timeFmt.format(start)} – ${dateFmt.format(end)} ${timeFmt.format(end)}`;
  const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const lines = [`📊 <b>Итог за сутки</b> · ${period}`];
  if (!total.count) {
    lines.push(`💰 <b>${nf2.format(total.rub)} ₽</b> · зарядок не было`);
    return lines.join('\n');
  }
  lines.push(`💰 <b>${nf2.format(total.rub)} ₽</b> · ${total.count} ${plural(total.count, 'зарядка', 'зарядки', 'зарядок')} · ${nf0.format(total.kwh)} кВт⋅ч`);
  const stations = [...byStation.entries()].filter(([, s]) => s.count).sort((a, b) => b[1].rub - a[1].rub);
  if (stations.length > 1) {
    for (const [name, s] of stations) lines.push(`• ${esc(name)} — ${nf2.format(s.rub)} ₽ · ${s.count} · ${nf0.format(s.kwh)} кВт⋅ч`);
  }
  return lines.join('\n');
}

export function formatStatusTest(stations) {
  const lines = ['🧪 <i>Тестовое сообщение — связь станций сейчас</i>'];
  for (const s of stations.filter((x) => !x.archived)) lines.push(`${s.connected ? '🟢' : '🔴'} ${esc(s.name)} — ${s.connected ? 'на связи' : 'нет связи'}`);
  return lines.join('\n');
}

async function gql(query, variables, token) {
  const headers = { 'content-type': 'application/json', tenant: TENANT, 'x-application-version': '2.0.0-admin-panel' };
  if (token) headers.authorization = token;
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const json = await res.json().catch(() => null);
  if (res.status === 401 || json?.errors?.some((e) => e.extensions?.constant === 'UNAUTHORIZED')) {
    const err = new Error('IT Charge API: токен не принят');
    err.auth = true;
    throw err;
  }
  if (!json) throw new Error(`IT Charge API: HTTP ${res.status}`);
  if (json.errors?.length) throw new Error(`IT Charge API: ${json.errors[0].message}`);
  return json.data;
}

async function login(email, password) {
  const data = await gql(
    `query UserLogin($email: String!, $password: String!, $tenant: String) {
      UserLogin(email: $email, password: $password, tenant: $tenant) { token }
    }`,
    { email, password, tenant: TENANT },
  );
  if (!data.UserLogin?.token) throw new Error('IT Charge: не удалось войти — проверьте ITCHARGE_EMAIL и ITCHARGE_PASSWORD');
  return data.UserLogin.token;
}

async function transactionsPage(token, number, size) {
  const data = await gql(
    `query Tx($page: Page!, $orderBy: [TransactionsListRequestOrderInputType!]) {
      TransactionsList(page: $page, orderBy: $orderBy) { rows { ${TX_FIELDS} } }
    }`,
    { page: { size, number }, orderBy: [{ seqNo: 'desc' }] },
    token,
  );
  return data.TransactionsList.rows;
}

const latestTransactions = (token) => transactionsPage(token, 1, PAGE_SIZE);

// Все транзакции, начатые после since (страницы идут от новых к старым).
async function transactionsSince(token, since) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await transactionsPage(token, page, 100);
    all.push(...rows);
    if (rows.length < 100 || rows.some((r) => Date.parse(r.startedTimestamp) < since)) break;
  }
  return all;
}

async function stationStatuses(token) {
  const data = await gql(`query { ChargingStationsList(page: { size: 100, number: 1 }) { rows { ${STATION_FIELDS} } } }`, {}, token);
  return data.ChargingStationsList.rows;
}

// Приводит id канала к виду, который понимает Telegram: «@имя» или «-100…».
// Принимает и ссылки t.me/имя, и номер из ссылки t.me/c/<номер>/… без префикса -100.
export function normalizeChatId(value) {
  const v = String(value ?? '').trim().replace(/^["'«]+|["'»]+$/g, '').trim();
  // Адрес канала в web.telegram.org: …/k/#-1001234567890 или …/a/#@имя
  const web = v.match(/web\.telegram\.org\/\w\/#(-?\d+|@\w+)/);
  if (web) return web[1];
  const link = v.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:c\/(\d+)|(?!joinchat\/)([A-Za-z]\w{3,}))/);
  if (link) return link[1] ? `-100${link[1]}` : `@${link[2]}`;
  if (/^[A-Za-z]\w{3,}$/.test(v)) return `@${v}`;
  return v;
}

// Описание формата без самого значения — чтобы не светить id канала в логах.
function describeChatId(value) {
  const v = String(value ?? '');
  if (/^@\w+$/.test(v)) return '@имя';
  if (/^-100\d+$/.test(v)) return 'число -100…';
  if (/^-\d+$/.test(v)) return 'отрицательное число без -100 (id группы, а не канала?)';
  if (/^\d+$/.test(v)) return 'положительное число (так выглядит id пользователя, а не канала)';
  if (/t\.me\/(\+|joinchat\/)/.test(v)) return 'ссылка-приглашение t.me/+… — по ней id не определить';
  if (/^https?:\/\//.test(v)) return 'ссылка, но не на канал';
  if (/\s|[А-Яа-яЁё]/.test(v)) return 'текст с пробелами или кириллицей — похоже на название канала';
  return `нераспознанный формат, ${v.length} символов`;
}

async function telegram(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

async function sendTelegram(botToken, chatId, text) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  let json = await telegram(botToken, 'sendMessage', payload);
  // Номер канала без -100 (из ссылки t.me/c/…) — пробуем ещё раз с префиксом.
  if (!json.ok && /chat not found/i.test(json.description ?? '') && /^\d+$/.test(chatId)) {
    json = await telegram(botToken, 'sendMessage', { ...payload, chat_id: `-100${chatId}` });
  }
  if (!json.ok) {
    const me = await telegram(botToken, 'getMe', {});
    const bot = me.ok ? `@${me.result.username}` : 'токен не принят Telegram';
    throw new Error(`Telegram: ${json.description ?? 'ошибка'} · бот: ${bot} · формат TELEGRAM_CHAT_ID: ${describeChatId(chatId)}`);
  }
}

// Одна проверка. state — опубликованные зарядки, тревоги, дата последнего итога
// (null при первом запуске); token — сохранённый токен IT Charge, чтобы не логиниться
// каждую минуту. Возвращает новое состояние и токен — их нужно сохранить, даже если
// в result.error пришла ошибка отправки: уже отправленное повторно не уйдёт.
export async function check({ secrets, state, token, test = false, now = Date.now() }) {
  const bot = secrets.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = normalizeChatId(secrets.TELEGRAM_CHAT_ID);
  const creds = { ITCHARGE_EMAIL: secrets.ITCHARGE_EMAIL?.trim(), ITCHARGE_PASSWORD: secrets.ITCHARGE_PASSWORD, TELEGRAM_BOT_TOKEN: bot, TELEGRAM_CHAT_ID: chatId };
  const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { state, token, log: `Не заданы секреты: ${missing.join(', ')} — пропускаю запуск` };

  // Сохранённый токен используем, пока API его принимает; не принял — входим заново.
  const withToken = async (fn) => {
    if (!token) token = await login(creds.ITCHARGE_EMAIL, creds.ITCHARGE_PASSWORD);
    try {
      return await fn(token);
    } catch (err) {
      if (!err.auth) throw err;
      token = await login(creds.ITCHARGE_EMAIL, creds.ITCHARGE_PASSWORD);
      return fn(token);
    }
  };

  const [rows, stations] = await withToken((t) => Promise.all([latestTransactions(t), stationStatuses(t)]));
  const log = [];

  if (test) {
    const last = rows.find((r) => r.transactionStep === 'FINISHED_SUCCESS' && r.totalKW > 0);
    if (last) await sendTelegram(bot, chatId, formatMessage(last, { test: true }));
    await sendTelegram(bot, chatId, formatStatusTest(stations));
    log.push('тестовые сообщения отправлены');
  }

  // Первый запуск: старые зарядки не публикуем, а о станциях без связи — сообщаем.
  const firstRun = !state;
  if (firstRun) {
    state = initState(rows);
    log.push('первый запуск: текущие зарядки отмечены');
  }

  const stationMsgs = stationEvents(stations, state, now);
  const charges = firstRun ? [] : pickNew(rows, state);
  const queue = [...stationMsgs, ...charges.map((t) => ({ text: formatMessage(t), apply: () => state.notified.push(t.id) }))];

  // Суточный итог — один раз за сутки. Впервые — без отправки: начинаем со следующих 22:00.
  const end = lastDailyEnd(now);
  const key = dailyKey(end);
  let daily = false;
  if (!state.lastDaily) state.lastDaily = key;
  else if (state.lastDaily < key && now - end >= 60e3) {
    const txs = await withToken((t) => transactionsSince(t, end - 2 * DAY));
    queue.push({ text: formatDaily(txs, end - DAY, end), apply: () => (state.lastDaily = key) });
    daily = true;
  }

  let sent = 0;
  let error = null;
  try {
    for (const m of queue) {
      await sendTelegram(bot, chatId, m.text);
      m.apply();
      sent++;
    }
  } catch (err) {
    error = err.message;
  }
  state.notified = state.notified.slice(-KEEP_IDS);
  log.push(`новых зарядок: ${charges.length}, событий связи: ${stationMsgs.length}, суточный итог: ${daily ? 'да' : 'нет'}, опубликовано: ${sent}`);
  return { state, token, log: log.join('; '), error };
}
