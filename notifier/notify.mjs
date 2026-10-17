// Публикует в Telegram-канал итог каждой завершённой зарядки из IT Charge.
// Запускается из GitHub Actions по расписанию: node notifier/notify.mjs <state.json>
// Состояние — какие зарядки уже опубликованы. Логи репозитория публичные,
// поэтому в консоль пишутся только счётчики, без данных о зарядках.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://api.itcharge.ru/graphql/cp';
const TENANT = 'itcharge';
const FINISHED = new Set(['FINISHED_SUCCESS', 'FINISHED_WITH_ERROR', 'CANCELED']);
const PAGE_SIZE = 50; // столько последних транзакций проверяем за запуск
const KEEP_IDS = 300;

const CONNECTORS = { GBT_DC: 'GB/T DC', GBT_AC: 'GB/T AC', C_TYPE2: 'Type 2', C_TYPE1: 'Type 1', C_CCS2: 'CCS2', C_CHADEMO: 'CHAdeMO' };
const INITIATORS = { CUSTOMER: 'клиент', CHARGING_STATION: 'станция', USER: 'оператор', CSMS_BALANCE_EXCEEDED: 'кончился баланс' };

const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDuration = (min) => {
  const m = Math.round(min ?? 0);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
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

async function gql(query, variables, token) {
  const headers = { 'content-type': 'application/json', tenant: TENANT, 'x-application-version': '2.0.0-admin-panel' };
  if (token) headers.authorization = token;
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const json = await res.json().catch(() => null);
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

async function latestTransactions(token) {
  const data = await gql(
    `query Tx($page: Page!, $orderBy: [TransactionsListRequestOrderInputType!]) {
      TransactionsList(page: $page, orderBy: $orderBy) { rows { ${TX_FIELDS} } }
    }`,
    { page: { size: PAGE_SIZE, number: 1 }, orderBy: [{ seqNo: 'desc' }] },
    token,
  );
  return data.TransactionsList.rows;
}

async function sendTelegram(botToken, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram: ${json.description ?? `HTTP ${res.status}`}`);
}

async function main() {
  const { ITCHARGE_EMAIL, ITCHARGE_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  const test = process.env.TEST === 'true';
  const statePath = process.argv[2] ?? 'state.json';

  const missing = Object.entries({ ITCHARGE_EMAIL, ITCHARGE_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.log(`Не заданы секреты: ${missing.join(', ')} — пропускаю запуск`);
    return;
  }

  const raw = await readFile(statePath, 'utf8').catch(() => '');
  let state = raw.trim() ? JSON.parse(raw) : null;

  const token = await login(ITCHARGE_EMAIL, ITCHARGE_PASSWORD);
  const rows = await latestTransactions(token);

  if (test) {
    const last = rows.find((r) => r.transactionStep === 'FINISHED_SUCCESS' && r.totalKW > 0);
    if (!last) throw new Error('Нет завершённых зарядок для теста');
    await sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, formatMessage(last, { test: true }));
    console.log('Тестовое сообщение отправлено');
  }

  if (!state) {
    state = initState(rows);
    await writeFile(statePath, JSON.stringify(state));
    console.log('Первый запуск: текущие зарядки отмечены, публикую только новые');
    return;
  }

  const fresh = pickNew(rows, state);
  let sent = 0;
  try {
    for (const t of fresh) {
      await sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, formatMessage(t));
      state.notified.push(t.id);
      sent++;
    }
  } finally {
    state.notified = state.notified.slice(-KEEP_IDS);
    await writeFile(statePath, JSON.stringify(state));
    console.log(`Новых зарядок: ${fresh.length}, опубликовано: ${sent}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
