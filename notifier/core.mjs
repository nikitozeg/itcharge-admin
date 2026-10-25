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
const INITIATORS = { CUSTOMER: 'клиент', CHARGING_STATION: 'станция', USER: 'оператор', CSMS_BALANCE_EXCEEDED: 'кончился баланс', CAR: 'машина', OCPI: 'роуминг' };
// Неудачные попытки: тревога, если клиент не начал заряжаться за FAIL_GRACE_MIN после первой попытки.
const FAIL_GRACE_MIN = 5;
const FAIL_REPEAT_MIN = 20; // вторая неудачная попытка в пределах 20 мин — сразу тревога с телефоном
const FAIL_FOLLOW_MIN = 60; // столько ждём, что клиент всё же зарядится, чтобы ответить ✅
const STOP_REASONS = {
  EVDISCONNECTED: 'связь с машиной разорвана', REMOTE: 'остановлено из приложения', LOCAL: 'остановлено кнопкой на станции',
  OTHER: 'другая причина', TIMEOUT: 'машина не ответила вовремя', DEAUTHORIZED: 'авторизация отклонена', EMERGENCYSTOP: 'аварийная кнопка', POWERLOSS: 'пропало питание',
  HARDRESET: 'станция перезагрузилась', SOFTRESET: 'станция перезагрузилась', REBOOT: 'станция перезагрузилась', UNLOCKCOMMAND: 'разъём разблокирован',
};
const CHARGING_STATES = { EVCONNECTED: 'машина подключена', SUSPENDED_EV: 'машина не берёт ток', SUSPENDED_EVSE: 'станция не даёт ток', IDLE: 'кабель не подключён', CHARGING: 'шла зарядка' };

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
  totalDuration idleDuration startedPercentage percentage stopInitiator stoppedReason chargingState
  tariff { type amount name }
  connector { id evseId type }
  authorization { customer { id seqNo } }
  invoice { amount }
  payment { amount }
  chargingStation { id name }`;

// Другие машины, заряжавшиеся на той же станции одновременно с t: сколько их было всего,
// сколько максимум одновременно (не больше, чем свободных разъёмов) и сколько минут
// суммарно рядом кто-то заряжался. Не считаем: микросессии меньше 1 кВт⋅ч (по сути
// неудачные старты), касания короче 2 минут и «сессии» на том же разъёме (сбой данных).
// rows — последние транзакции; идущие сейчас зарядки длятся до now.
export function parallelInfo(t, rows, now = Date.now()) {
  const start = Date.parse(t.startedTimestamp ?? '');
  const stop = Date.parse(t.stoppedTimestamp ?? '') || now;
  if (!start) return null;
  const station = t.chargingStation?.id ?? t.chargingStation?.name;
  const overlaps = [];
  for (const o of rows) {
    if (o.id === t.id || (o.chargingStation?.id ?? o.chargingStation?.name) !== station) continue;
    if (t.connector?.id != null && o.connector?.id === t.connector.id) continue;
    const active = o.transactionStep === 'CHARGING' || o.transactionStep === 'CABLE_PLUGGED_IN';
    if (!(o.totalKW >= 1) && !active) continue;
    const os = Date.parse(o.startedTimestamp ?? '');
    const oe = Date.parse(o.stoppedTimestamp ?? '') || (active ? now : os);
    const a = Math.max(start, os);
    const b = Math.min(stop, oe);
    if (b - a >= 2 * 60e3) overlaps.push([a, b]);
  }
  if (!overlaps.length) return null;
  // максимум одновременно — проходом по началам и концам
  const ev = overlaps.flatMap(([a, b]) => [[a, 1], [b, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of ev) peak = Math.max(peak, (cur += d));
  // минуты, когда рядом заряжался хоть кто-то (пересечения объединяем)
  overlaps.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let iv = null;
  for (const o of overlaps) {
    if (iv && o[0] <= iv[1]) iv[1] = Math.max(iv[1], o[1]);
    else {
      if (iv) total += iv[1] - iv[0];
      iv = [...o];
    }
  }
  total += iv[1] - iv[0];
  return { cars: overlaps.length, peak, minutes: total / 60e3, of: t.totalDuration ?? (stop - start) / 60e3 };
}

// Текст сообщения (HTML-разметка Telegram). Данных клиента в нём нет.
export function formatMessage(t, { test = false, parallel = null } = {}) {
  const kwh = t.totalKW ?? 0;
  const rub = t.invoice?.amount ?? t.payment?.amount ?? 0;
  const conn = CONNECTORS[t.connector?.type] ?? t.connector?.type?.replace(/^C_/, '').replace(/_/g, ' ') ?? '';
  const start = t.startedTimestamp ? new Date(t.startedTimestamp) : null;
  const stop = t.stoppedTimestamp ? new Date(t.stoppedTimestamp) : null;
  const icon = t.transactionStep === 'FINISHED_SUCCESS' ? '⚡' : '⚠️';
  const status = t.transactionStep === 'FINISHED_WITH_ERROR' ? ' · завершена с ошибкой' : t.transactionStep === 'CANCELED' ? ' · отменена' : '';

  // Цена за кВт⋅ч: из тарифа, если он покиловаттный, иначе — сумма / энергия.
  const perKwh = t.tariff?.type === 'PER_KW' && t.tariff?.amount ? t.tariff.amount : kwh > 0 && rub ? rub / kwh : null;
  // ❗ сверху — бесплатный тариф (нет тарифа или 0 ₽ и оплаты нет) или 14 ₽: так электричество не окупается.
  const isFree = kwh > 0 && !(rub > 0) && !(t.tariff?.amount > 0);
  const is14 = !isFree && perKwh != null && Math.abs(perKwh - 14) < 0.05;

  const lines = [];
  if (isFree) lines.push('❗ <b>Бесплатный тариф</b> — зарядка без оплаты');
  if (is14) lines.push('❗ <b>Тариф 14 ₽/кВт⋅ч</b>');
  if (test) lines.push('🧪 <i>Тестовое сообщение — последняя завершённая зарядка</i>');
  // Название станции не пишем — её видно по разъёму; без разъёма — название как запасной вариант.
  lines.push(`${icon} <b>${esc(conn || t.chargingStation?.name || 'Зарядка')}</b>${status}`);

  const battery = t.startedPercentage != null && t.percentage != null ? ` · батарея ${t.startedPercentage}% → ${t.percentage}%` : '';
  lines.push(`🔋 <b>${nf2.format(kwh)} кВт⋅ч</b>${battery}`);

  if (rub || perKwh) lines.push(`💰 <b>${nf2.format(rub)} ₽</b>${perKwh ? ` · ${nf2.format(perKwh)} ₽/кВт⋅ч` : ''}`);

  if (start) {
    const when = `${dateFmt.format(start)}, ${timeFmt.format(start)}${stop ? `–${timeFmt.format(stop)}` : ''}`;
    lines.push(`⏱ ${when} · ${fmtDuration(t.totalDuration)}`);
  }
  const power = [t.avgPower != null && `ср. ${nf1.format(t.avgPower)}`, t.maxPower != null && `макс. ${nf1.format(t.maxPower)}`].filter(Boolean);
  if (power.length) lines.push(`📈 ${power.join(' · ')} кВт`);
  if (parallel) {
    const { cars, peak } = parallel;
    const who = peak <= 1
      ? cars === 1 ? 'заряжалась ещё одна машина' : `заряжались другие машины — по одной, всего ${cars}`
      : cars === peak
        ? `заряжались ещё ${peak} ${plural(peak, 'машина', 'машины', 'машин')} одновременно`
        : `заряжались до ${peak} машин одновременно (всего ${cars})`;
    lines.push(`👥 параллельно ${who} · ${fmtDuration(parallel.minutes)} из ${fmtDuration(parallel.of)}`);
  }
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

// Короткое имя станции: последнее слово названия без пометок в скобках («Йошкар-Ола Кремль АС22» → «АС22»).
const shortStation = (name) => String(name ?? 'Станция').replace(/\s*\(.*\)\s*$/, '').trim().split(/\s+/).pop();

// «🟢 АС22 - Был оффлайн 32 мин (00:32 – 01:04)»; если обрыв начался в другой день — с датой начала.
export function formatOnline(s, since, back) {
  const name = esc(shortStation(s.name));
  if (!since) return `🟢 ${name} - снова на связи`;
  const from = dateFmt.format(since) === dateFmt.format(back) ? timeFmt.format(since) : fmtWhen(since);
  return `🟢 ${name} - Был оффлайн ${fmtDuration((back - since) / 60e3)} (${from} – ${timeFmt.format(back)})`;
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
// ---------- месячный итог (1-го числа в 00:00 МСК) ----------

const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
// Начало месяца (1-е число, 00:00 МСК) для момента ms, со сдвигом на shift месяцев.
export function monthStart(ms, shift = 0) {
  const d = new Date(ms + MSK);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + shift, 1) - MSK;
}
export const monthKey = (start) => new Date(start + MSK).toISOString().slice(0, 7);
const monthTitle = (start) => {
  const d = new Date(start + MSK);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
// Завершённые зарядки с энергией, закончившиеся в [start, end).
const doneIn = (rows, start, end) => rows.filter((r) => {
  const stop = Date.parse(r.stoppedTimestamp ?? '');
  return FINISHED.has(r.transactionStep) && r.totalKW > 0 && stop >= start && stop < end;
});
const STOP_GROUPS = [['CUSTOMER', 'клиент'], ['CHARGING_STATION', 'станция (машина зарядилась)'], ['CSMS_BALANCE_EXCEEDED', 'кончился баланс']];

// prev — тот же месяц прошлых лет: [{ start, kwh }], от ближнего к дальнему.
export function formatMonthly(rows, start, end, prev = [], { test = false } = {}) {
  const done = doneIn(rows, start, end);
  const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const rub = done.reduce((a, r) => a + (r.invoice?.amount ?? r.payment?.amount ?? 0), 0);
  const kwh = done.reduce((a, r) => a + r.totalKW, 0);
  const lines = [];
  if (test) lines.push('🧪 <i>Тестовое сообщение — месячный итог</i>');
  lines.push(`🗓 <b>Итог за ${monthTitle(start)}</b>`);
  if (!done.length) {
    lines.push('💰 <b>0 ₽</b> · зарядок не было');
    return lines.join('\n');
  }
  lines.push(`💰 <b>${nf2.format(rub)} ₽</b> · ${done.length} ${plural(done.length, 'зарядка', 'зарядки', 'зарядок')} · ${nf0.format(kwh)} кВт⋅ч`);
  const byStation = new Map();
  for (const r of done) {
    const name = r.chargingStation?.name ?? 'Станция';
    const acc = byStation.get(name) ?? { rub: 0, kwh: 0, count: 0 };
    acc.rub += r.invoice?.amount ?? r.payment?.amount ?? 0;
    acc.kwh += r.totalKW;
    acc.count++;
    byStation.set(name, acc);
  }
  if (byStation.size > 1) {
    for (const [name, a] of [...byStation].sort((x, y) => y[1].rub - x[1].rub)) lines.push(`• ${esc(name)} — ${nf2.format(a.rub)} ₽ · ${a.count} · ${nf0.format(a.kwh)} кВт⋅ч`);
  }
  // кто остановил зарядку
  const counts = new Map(STOP_GROUPS.map(([k]) => [k, 0]));
  let other = 0;
  for (const r of done) counts.has(r.stopInitiator) ? counts.set(r.stopInitiator, counts.get(r.stopInitiator) + 1) : other++;
  const pct = (n) => `${Math.round((n / done.length) * 100)}% (${n})`;
  lines.push('🛑 <b>Кто остановил</b>');
  for (const [k, label] of STOP_GROUPS) lines.push(`• ${label} — ${pct(counts.get(k))}`);
  if (other) lines.push(`• прочее — ${pct(other)}`);
  // кВт⋅ч к тому же месяцу прошлых лет
  if (prev.length) {
    lines.push('📈 <b>кВт⋅ч к прошлым годам</b>');
    for (const p of prev) {
      const d = (kwh / p.kwh - 1) * 100;
      const arrow = Math.abs(d) < 0.5 ? '•' : d > 0 ? '▲' : '▼';
      lines.push(`• ${monthTitle(p.start)}: ${nf0.format(p.kwh)} кВт⋅ч → ${arrow} ${d > 0 ? '+' : d < 0 ? '−' : ''}${nf0.format(Math.abs(d))}%`);
    }
  } else lines.push('📈 сравнить не с чем — за этот месяц прошлых лет данных нет');
  return lines.join('\n');
}

export function formatDaily(rows, start, end) {
  const byStation = new Map();
  for (const r of rows) {
    const stop = Date.parse(r.stoppedTimestamp ?? '');
    if (!FINISHED.has(r.transactionStep) || !(stop >= start && stop < end)) continue;
    const name = r.chargingStation?.name ?? 'Станция';
    const acc = byStation.get(name) ?? { rub: 0, kwh: 0, count: 0, balance: 0 };
    acc.rub += r.invoice?.amount ?? r.payment?.amount ?? 0;
    acc.kwh += r.totalKW ?? 0;
    if (r.totalKW > 0) acc.count++;
    if (r.totalKW > 0 && r.stopInitiator === 'CSMS_BALANCE_EXCEEDED') acc.balance++; // зарядку остановила система: у клиента кончились деньги
    byStation.set(name, acc);
  }
  const total = [...byStation.values()].reduce((a, s) => ({ rub: a.rub + s.rub, kwh: a.kwh + s.kwh, count: a.count + s.count, balance: a.balance + s.balance }), { rub: 0, kwh: 0, count: 0, balance: 0 });
  const period = `${dateFmt.format(start)} ${timeFmt.format(start)} – ${dateFmt.format(end)} ${timeFmt.format(end)}`;
  const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const lines = [`📊 <b>Итог за сутки</b> · ${period}`];
  if (!total.count) {
    lines.push(`💰 <b>${nf2.format(total.rub)} ₽</b> · зарядок не было`);
    return lines.join('\n');
  }
  lines.push(`💰 <b>${nf2.format(total.rub)} ₽</b> · ${total.count} ${plural(total.count, 'зарядка', 'зарядки', 'зарядок')} · ${nf0.format(total.kwh)} кВт⋅ч`);
  lines.push(`💳 кончился баланс: ${total.balance} из ${total.count}${total.balance ? ` (${Math.round((total.balance / total.count) * 100)}%)` : ''}`);
  const stations = [...byStation.entries()].filter(([, s]) => s.count).sort((a, b) => b[1].rub - a[1].rub);
  if (stations.length > 1) {
    for (const [name, s] of stations) lines.push(`• ${esc(name)} — ${nf2.format(s.rub)} ₽ · ${s.count} · ${nf0.format(s.kwh)} кВт⋅ч`);
  }
  return lines.join('\n');
}

// ---------- неудачные попытки зарядки ----------

const tStart = (r) => Date.parse(r.startedTimestamp ?? '') || 0;
const tStop = (r) => Date.parse(r.stoppedTimestamp ?? '') || tStart(r);
const isFail = (r) => (r.transactionStep === 'CANCELED' || r.transactionStep === 'FINISHED_WITH_ERROR') && !(r.totalKW > 0);
const isCharge = (r) => r.totalKW > 0 || r.transactionStep === 'CHARGING';
// Кто пытается заряжаться: клиент на станции; без клиента — разъём станции.
const whoKey = (r) => `${r.chargingStation?.id ?? r.chargingStation?.name}|${r.authorization?.customer?.id ?? `разъём ${r.connector?.id}`}`;

// Разбор неудачных попыток. Серия — неудачные попытки одного клиента на одной станции,
// каждая не позже FAIL_REPEAT_MIN после предыдущей и без удачной зарядки между ними.
//  • вторая попытка серии — сразу тревога с телефоном клиента (или ответ с телефоном
//    на уже отправленную тревогу);
//  • одна попытка — тревога, если за FAIL_GRACE_MIN клиент так и не начал заряжаться;
//  • зарядился в пределах FAIL_GRACE_MIN — молчим; позже — отвечаем ✅ (ждём FAIL_FOLLOW_MIN).
// Возвращает alerts и follows; apply() меняет состояние только после успешной отправки.
export function failureUpdates(rows, state, now = Date.now()) {
  const fails = rows.filter(isFail).sort((a, b) => tStart(a) - tStart(b));
  if (!state.failSeen) {
    // впервые — старые отмены не разбираем
    state.failSeen = fails.map((r) => r.id);
    state.failOpen = {};
    return { alerts: [], follows: [] };
  }
  state.failOpen ??= {};
  const seen = new Set(state.failSeen);
  const charges = rows.filter(isCharge).sort((a, b) => tStart(a) - tStart(b));
  const successAfter = (key, t) => charges.find((c) => whoKey(c) === key && tStart(c) >= t - 60e3);
  const customerOf = (r) => r.authorization?.customer?.id ?? null;
  const repeatMs = FAIL_REPEAT_MIN * 60e3;

  const alerts = [];
  const follows = [];
  const open = new Map(); // key → sid серий, которые ещё ждут
  for (const [sid, o] of Object.entries(state.failOpen)) {
    const ok = successAfter(o.key, o.t0);
    if (ok) follows.push({ text: formatFailureFollow(o, ok), replyTo: o.msgId, apply: () => delete state.failOpen[sid] });
    else if (now - Math.max(o.alertedAt, o.lastFailAt ?? 0) > FAIL_FOLLOW_MIN * 60e3) follows.push({ silent: true, apply: () => delete state.failOpen[sid] });
    else open.set(o.key, sid);
  }

  const byKey = new Map();
  for (const f of fails) {
    if (seen.has(f.id)) continue;
    const key = whoKey(f);
    const sid = open.get(key);
    const o = sid && state.failOpen[sid];
    if (o && tStart(f) - (o.lastFailAt ?? o.t0) <= repeatMs) {
      // ещё одна попытка того, о ком уже сообщили: без новой тревоги, но с телефоном, если его не было
      o.attempts++;
      o.lastFailAt = tStop(f);
      state.failSeen.push(f.id);
      if (!o.phoneSent && !o.phoneQueued) {
        o.phoneQueued = true;
        alerts.push({ kind: 'phoneReply', series: [f], t0: o.t0, replyTo: o.msgId, txId: f.id, customerId: customerOf(f), needPhone: true,
          apply: () => { o.phoneSent = true; delete o.phoneQueued; } });
      }
      continue;
    }
    if (o) open.delete(key); // прошло больше FAIL_REPEAT_MIN — это уже новая серия
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  for (const o of Object.values(state.failOpen)) delete o.phoneQueued;

  for (const [key, list] of byKey) {
    let series = [];
    const flush = () => {
      if (!series.length) return;
      const s = series;
      series = [];
      const t0 = tStart(s[0]);
      const ok = successAfter(key, tStart(s[s.length - 1]));
      const markSeen = () => state.failSeen.push(...s.map((r) => r.id));
      const base = { kind: 'new', key, series: s, t0, customerId: customerOf(s[0]), txId: s[s.length - 1].id };
      const openSeries = (msgId, phoneSent) => (state.failOpen[s[0].id] = { key, t0, attempts: s.length, lastFailAt: tStop(s[s.length - 1]), alertedAt: now, msgId: msgId ?? null, phoneSent });
      if (ok && tStart(ok) - t0 <= FAIL_GRACE_MIN * 60e3) markSeen(); // быстро получилось — не тревожим
      else if (ok) alerts.push({ ...base, ok, apply: markSeen }); // уже зарядился, но не сразу — просто сообщаем
      else if (s.length >= 2) alerts.push({ ...base, needPhone: true, apply: (msgId) => { markSeen(); openSeries(msgId, true); } });
      else if (now - t0 >= FAIL_GRACE_MIN * 60e3) alerts.push({ ...base, apply: (msgId) => { markSeen(); openSeries(msgId, false); } });
    };
    for (const f of list) {
      const prev = series[series.length - 1];
      const succeededBetween = prev && charges.some((c) => whoKey(c) === key && tStart(c) >= tStart(prev) && tStart(c) <= tStart(f));
      if (prev && (tStart(f) - tStop(prev) > repeatMs || succeededBetween)) flush();
      series.push(f);
    }
    flush();
  }
  return { alerts, follows };
}

const fmtSec = (ms) => (ms < 60e3 ? `${Math.max(1, Math.round(ms / 1000))} сек` : fmtDuration(ms / 60e3));

// phone: строка с номером (или пояснение, почему номер скрыт) — только для тревог needPhone.
export function formatFailure(a, { history = null, now = Date.now(), test = false, phone = null } = {}) {
  const s = a.series;
  const f = s[0];
  const conn = CONNECTORS[f.connector?.type] ?? f.connector?.type?.replace(/^C_/, '').replace(/_/g, ' ') ?? '';
  const wait = (a.ok ? tStart(a.ok) : now) - a.t0;
  const lines = [];
  if (test) lines.push('🧪 <i>Тестовое сообщение — последняя неудачная попытка</i>');
  if (a.needPhone) lines.push(`📞 <b>${s.length} ${plural(s.length, 'неудачная попытка', 'неудачные попытки', 'неудачных попыток')} подряд — позвоните клиенту</b>`);
  else lines.push(a.ok ? `⚠️ <b>Не получалось зарядиться ${fmtDuration(wait / 60e3)}</b>` : `❌ <b>Не удаётся зарядиться — уже ${fmtDuration(wait / 60e3)}</b>`);
  const conns = [...new Set(s.map((r) => r.connector?.id).filter((x) => x != null))];
  lines.push(`🔌 <b>${esc(conn || f.chargingStation?.name || 'Станция')}</b>${conns.length ? ` · разъём ${conns.join(', ')}` : ''}`);
  const times = s.map((r) => timeFmt.format(new Date(tStart(r))));
  const durs = s.map((r) => tStop(r) - tStart(r));
  const durText = s.length === 1 ? `длилась ~${fmtSec(durs[0])}` : durs.every((d) => Math.abs(d - durs[0]) < 30e3) ? `каждая ~${fmtSec(durs[0])}` : durs.map(fmtSec).join(', ');
  lines.push(`🔁 ${s.length} ${plural(s.length, 'попытка', 'попытки', 'попыток')} · ${times.join(', ')} · ${durText}`);
  const causes = new Map();
  for (const r of s) {
    const who = r.stopInitiator && (INITIATORS[r.stopInitiator] ?? r.stopInitiator.replace(/_/g, ' ').toLowerCase());
    const c = [STOP_REASONS[r.stoppedReason] ?? r.stoppedReason?.toLowerCase(), who && `кто остановил — ${who}`, CHARGING_STATES[r.chargingState]].filter(Boolean).join(' · ');
    causes.set(c, (causes.get(c) ?? 0) + 1);
  }
  for (const [c, n] of causes) lines.push(`❓ ${esc(c || 'причина не указана')}${s.length > 1 ? ` (${n} из ${s.length})` : ''}`);
  const soc = s.find((r) => r.startedPercentage != null);
  if (soc) lines.push(`🔋 машина передала заряд ${soc.startedPercentage}% — связь со станцией была`);
  const cust = f.authorization?.customer?.seqNo;
  if (cust != null || history != null) {
    const hist = history == null ? '' : history > 0 ? ` · раньше заряжался у нас ${history} ${plural(history, 'раз', 'раза', 'раз')}` : ' · ни разу не заряжался у нас — возможно, дело в машине';
    lines.push(`👤 клиент №${cust ?? '—'}${hist}`);
  }
  if (phone) lines.push(`📞 ${esc(phone)}`);
  lines.push(`🧾 ${s.length > 1 ? 'транзакции' : 'транзакция'} ${s.map((r) => `№${r.seqNo}`).join(', ')}`);
  if (a.ok) lines.push(`✅ затем зарядился — через ${fmtDuration((tStart(a.ok) - a.t0) / 60e3)} после первой попытки`);
  return lines.join('\n');
}

// Ответ на уже отправленную тревогу: клиент снова не смог — телефон, чтобы позвонить.
export function formatPhoneReply(a, phone) {
  const f = a.series[0];
  const who = f.stopInitiator && (INITIATORS[f.stopInitiator] ?? f.stopInitiator.replace(/_/g, ' ').toLowerCase());
  const cause = [STOP_REASONS[f.stoppedReason] ?? f.stoppedReason?.toLowerCase(), who && `кто остановил — ${who}`].filter(Boolean).join(' · ');
  return [`📞 <b>Снова не получилось в ${timeFmt.format(new Date(tStart(f)))} — позвоните клиенту</b>`, phone ? `📞 ${esc(phone)}` : null, cause ? `❓ ${esc(cause)}` : null, `🧾 транзакция №${f.seqNo}`].filter(Boolean).join('\n');
}

function formatFailureFollow(o, ok) {
  return `✅ Всё же зарядился — через ${fmtDuration((tStart(ok) - o.t0) / 60e3)} после первой попытки, с ${o.attempts + 1}-й попытки`;
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
// Транзакции, созданные в [from, to) — фильтр по дате на стороне API (range), без листания всей истории.
async function transactionsInRange(token, from, to, fields = TX_FIELDS) {
  const all = [];
  for (let page = 1; page <= 15; page++) {
    const data = await gql(
      `query($c: FilterCompareTime, $p: Page!) { TransactionsList(createdAt: $c, page: $p, orderBy: [{ seqNo: desc }]) { rows { ${fields} } } }`,
      { c: { range: [new Date(from).toISOString(), new Date(to).toISOString()] }, p: { size: 100, number: page } },
      token,
    );
    const rows = data.TransactionsList.rows;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

// Текст месячного итога за месяц, начинающийся в mStart (зарядки — по времени окончания).
export async function monthlyReport(withToken, mStart, { test = false } = {}) {
  const mEnd = monthStart(mStart, 1);
  const cur = await withToken((t) => transactionsInRange(t, mStart - 2 * DAY, mEnd));
  const prev = [];
  for (let n = 1; n <= 5; n++) {
    const ps = monthStart(mStart, -12 * n);
    const pe = monthStart(ps, 1);
    const rows = await withToken((t) => transactionsInRange(t, ps - 2 * DAY, pe, 'transactionStep startedTimestamp stoppedTimestamp totalKW'));
    if (!rows.length) break; // раньше станций ещё не было
    const kwh = doneIn(rows, ps, pe).reduce((a, r) => a + r.totalKW, 0);
    if (kwh > 0) prev.push({ start: ps, kwh });
  }
  return formatMonthly(cur, mStart, mEnd, prev, { test });
}

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

// Телефон клиента по транзакции — запрашивается только для тревоги «позвоните клиенту»
// и нигде не сохраняется.
async function transactionPhone(token, txId) {
  const data = await gql(
    `query($id: FilterUuid) { TransactionsList(id: $id, page: { size: 1, number: 1 }) { rows { authorization { customer { phone } } } } }`,
    { id: { eq: txId } },
    token,
  );
  return data.TransactionsList.rows[0]?.authorization?.customer?.phone ?? null;
}

// Сколько раз клиент успешно заряжался на наших станциях — подсказка, машина виновата или станция.
async function customerSuccessCount(token, customerId) {
  const data = await gql(
    `query($c: CustomerInputFilter, $s: FilterCompareTransactionSteps) {
      TransactionsList(customer: $c, transactionStep: $s, page: { size: 1, number: 1 }) { count }
    }`,
    { c: { id: { eq: customerId } }, s: { eq: 'FINISHED_SUCCESS' } },
    token,
  );
  return data.TransactionsList.count;
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

// Отправляет сообщение (replyTo — ответом на другое) и возвращает его message_id.
async function sendTelegram(botToken, chatId, text, replyTo = null) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
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
  return json.result?.message_id ?? null;
}

// Одна проверка. state — опубликованные зарядки, тревоги, дата последнего итога
// (null при первом запуске); token — сохранённый токен IT Charge, чтобы не логиниться
// каждую минуту. Возвращает новое состояние и токен — их нужно сохранить, даже если
// в result.error пришла ошибка отправки: уже отправленное повторно не уйдёт.
export async function check({ secrets, state, token, test = false, monthlyTest = false, now = Date.now() }) {
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

  // Телефон клиента показываем только в закрытом канале: в публичном его увидел бы кто угодно.
  let channelPublic = null;
  const phoneText = async (a) => {
    channelPublic ??= await telegram(bot, 'getChat', { chat_id: chatId }).then((j) => !j.ok || Boolean(j.result?.username)).catch(() => true);
    const n = a.series[0].authorization?.customer?.seqNo;
    if (channelPublic) return `номер не показан: канал публичный — клиент №${n ?? '—'} в панели IT Charge`;
    const phone = await withToken((t) => transactionPhone(t, a.txId)).catch(() => null);
    return phone ?? 'телефон в профиле клиента не указан';
  };
  if (test) {
    const last = rows.find((r) => r.transactionStep === 'FINISHED_SUCCESS' && r.totalKW > 0);
    if (last) await sendTelegram(bot, chatId, formatMessage(last, { test: true, parallel: parallelInfo(last, rows, now) }));
    await sendTelegram(bot, chatId, formatStatusTest(stations));
    // последняя серия неудачных попыток — чтобы увидеть, как выглядит тревога
    const sample = failureUpdates(rows, { failSeen: [], failOpen: {} }, now).alerts.sort((a, b) => b.t0 - a.t0)[0];
    if (sample) {
      const history = sample.customerId ? await withToken((t) => customerSuccessCount(t, sample.customerId)) : null;
      const phone = sample.needPhone ? await phoneText(sample) : null;
      await sendTelegram(bot, chatId, formatFailure(sample, { history, now, test: true, phone }));
    }
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

  // Неудачные попытки: тревога через FAIL_GRACE_MIN и ответ ✅, если клиент всё же зарядился.
  const fail = failureUpdates(rows, state, now);
  for (const f of fail.follows.filter((x) => x.silent)) f.apply();
  const failMsgs = [];
  for (const a of fail.alerts) {
    const phone = a.needPhone ? await phoneText(a) : null;
    if (a.kind === 'phoneReply') {
      failMsgs.push({ text: formatPhoneReply(a, phone), replyTo: a.replyTo, apply: a.apply });
      continue;
    }
    const history = a.customerId ? await withToken((t) => customerSuccessCount(t, a.customerId)).catch(() => null) : null;
    failMsgs.push({ text: formatFailure(a, { history, now, phone }), apply: a.apply });
  }
  const followMsgs = fail.follows.filter((x) => !x.silent);

  const queue = [
    ...stationMsgs,
    ...failMsgs,
    ...followMsgs,
    ...charges.map((t) => ({ text: formatMessage(t, { parallel: parallelInfo(t, rows, now) }), apply: () => state.notified.push(t.id) })),
  ];

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

  // Месячный итог — 1-го числа после 00:00 МСК за прошедший месяц. Впервые — без отправки.
  const mStart = monthStart(now, -1);
  const mKey = monthKey(mStart);
  let monthly = false;
  if (monthlyTest) queue.push({ text: await monthlyReport(withToken, mStart, { test: true }), apply: () => {} });
  if (!state.lastMonthly) state.lastMonthly = mKey;
  else if (state.lastMonthly < mKey && now - monthStart(now) >= 60e3) {
    queue.push({ text: await monthlyReport(withToken, mStart), apply: () => (state.lastMonthly = mKey) });
    monthly = true;
  }

  let sent = 0;
  let error = null;
  try {
    for (const m of queue) {
      const msgId = await sendTelegram(bot, chatId, m.text, m.replyTo ?? null);
      m.apply(msgId);
      sent++;
    }
  } catch (err) {
    error = err.message;
  }
  state.notified = state.notified.slice(-KEEP_IDS);
  if (state.failSeen) state.failSeen = state.failSeen.slice(-KEEP_IDS);
  log.push(`новых зарядок: ${charges.length}, событий связи: ${stationMsgs.length}, неудачных попыток: ${failMsgs.length} (+${followMsgs.length} ✅), суточный итог: ${daily ? 'да' : 'нет'}, месячный итог: ${monthly ? 'да' : 'нет'}, опубликовано: ${sent}`);
  return { state, token, log: log.join('; '), error };
}
