// Счета ТНС энерго за электричество: распознавание, комплект за месяц (аванс 30%,
// аванс 40%, окончательный), пени и полная статистика месяца для кнопок в канале.
import { MONTH_NAMES, monthTitle, monthStart, monthKey, doneIn, STOP_GROUPS, shortStation } from './core.mjs';

// Расходы помимо электричества (со слов владельца): комиссия IT Charge и постоянные.
const IT_CHARGE_FEE = 0.06;
const FIXED_MONTH = 50000 / 12 + 200; // ИП 50 тыс. ₽ в год + связь 200 ₽ в месяц
const DEFAULT_TARIFF_VAT = 13.34; // ₽/кВт⋅ч с НДС, если в счетах месяца тарифа нет

const MSK = 3 * 3600e3;
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plural = (n, one, few, many) => {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
};
const ruNum = (s) => Number(String(s).replace(/\s/g, '').replace('−', '-').replace(',', '.'));
const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'мая|май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const monthIndex = (word) => MONTH_STEMS.findIndex((st) => new RegExp(`^(${st})`, 'i').test(word));
const keyOf = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
const startOfKey = (key) => {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, 1) - MSK;
};

export const KINDS = { adv30: 'аванс 30%', adv40: 'аванс 40%', final: 'окончательный', penalty: 'пени' };

// Строки PDF → счёт или null. { number, issued, kind, month: 'YYYY-MM', amount, kwh, tariff }
export function parseInvoice(lines) {
  const text = lines.join('\n');
  if (!/ТНС энерго|электроэнерги/i.test(text)) return null;
  const numM = text.match(/№\s*(\d{6,}\/\d+)\s+от\s+(\d{2})\.(\d{2})\.(\d{4})/);
  const payM = text.match(/К оплате:?\s*(-?[\d\s]+,\d{2})\s*руб/i);
  if (!numM || !payM) return null;
  const issued = `${numM[4]}-${numM[3]}-${numM[2]}`;
  const inv = { number: numM[1], issued, amount: ruNum(payM[1]), kwh: null, tariff: null };
  if (/оплату\s+пеней/i.test(text)) {
    // пени относим к месяцу, в котором выставлен счёт
    return { ...inv, kind: 'penalty', month: issued.slice(0, 7) };
  }
  const per = text.match(/(?:(\d{2})\s*%\s*)?за\s+([А-Яа-яё]+)\s+(\d{4})\s*г/i);
  if (!per || monthIndex(per[2]) < 0) return null;
  const kind = per[1] === '30' ? 'adv30' : per[1] === '40' ? 'adv40' : per[1] ? null : 'final';
  if (!kind) return null;
  // строка с энергией: «… (менее 670 кВт)  982,89  10,93252  10 745,46  2 364,00  13 109,46»
  const row = lines.find((l) => /электроэнергия/i.test(l) && l.split(/\s{2,}/).length >= 5);
  if (row) {
    const cells = row.split(/\s{2,}/).filter((c) => /^-?[\d\s]+(,\d+)?$/.test(c.trim()));
    const nums = cells.map(ruNum).filter((x) => !Number.isNaN(x));
    // номер строки «1» в начале — не количество
    const vals = /^\d+\s{2,}/.test(row) ? nums.slice(1) : nums;
    if (vals.length >= 2) [inv.kwh, inv.tariff] = vals;
  }
  return { ...inv, kind, month: keyOf(Number(per[3]), monthIndex(per[2])) };
}

// Ручной ввод ответом на «не смог распознать»: «30% октябрь 2026 13109,46», «окончательный сентябрь 4321,10», «пени сентябрь 66,43».
export function parseManual(text, now = Date.now()) {
  const t = text.toLowerCase();
  const kind = /\b30\s*%/.test(t) ? 'adv30' : /\b40\s*%/.test(t) ? 'adv40' : /оконч|финал|итог/.test(t) ? 'final' : /пен/.test(t) ? 'penalty' : null;
  const mWord = t.split(/[\s,.;]+/).find((w) => /^[а-яё]{3,}$/.test(w) && monthIndex(w) >= 0 && !/оконч|финал|пен|аванс/.test(w));
  // сумма — последнее число (с копейками или целое); год и проценты убираем, чтобы не склеились с ней
  const rest = t.replace(/\b(30|40)\s*%/g, ' ').replace(/\b20\d\d\b/g, ' ');
  const amountM = rest.match(/-?\d[\d\s]*[.,]\d{1,2}(?!\d)/g) ?? rest.match(/\d[\d\s]*\d|\d/g);
  if (!kind || !mWord || !amountM) return null;
  const m = monthIndex(mWord);
  const yearM = t.match(/\b(20\d\d)\b/);
  const nowY = new Date(now + MSK).getUTCFullYear();
  const nowM = new Date(now + MSK).getUTCMonth();
  const year = yearM ? Number(yearM[1]) : m > nowM + 1 ? nowY - 1 : nowY;
  return { number: null, issued: null, kind, month: keyOf(year, m), amount: ruNum(amountM.at(-1).replace('.', ',')), kwh: null, tariff: null };
}

// Состояние комплекта счетов месяца: для каждого вида — счёт, «ждём» или «не хватает».
// Авансы ТНС выставляет 1-го числа месяца (оплата до 10-го и 25-го), окончательный — в начале следующего (до 18-го).
export function monthInvoices(invoices, key, now = Date.now()) {
  const s = startOfKey(key);
  const nextS = monthStart(s, 1);
  const expectFrom = { adv30: s, adv40: s, final: nextS + 9 * 86400e3 };
  const due = { adv30: s + 9 * 86400e3, adv40: s + 24 * 86400e3, final: nextS + 17 * 86400e3 };
  const mine = invoices.filter((i) => i.month === key);
  // «не хватает» — только с месяца, за который загружен самый ранний счёт; раньше счета просто не вели
  const tracking = invoices.some((i) => i.kind !== 'penalty' && i.month <= key);
  const items = ['adv30', 'adv40', 'final'].map((kind) => {
    const inv = mine.find((i) => i.kind === kind) ?? null;
    const state = inv ? 'ok' : !tracking ? 'none' : now >= expectFrom[kind] ? 'missing' : 'waiting';
    return { kind, inv, state, due: due[kind] };
  });
  const penalties = mine.filter((i) => i.kind === 'penalty');
  return { key, items, penalties, tracking, complete: items.every((i) => i.inv), missing: items.filter((i) => i.state === 'missing') };
}

const dateRu = (ms) => {
  const d = new Date(ms + MSK);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
};
const missingText = (st) => st.missing.map((i) => KINDS[i.kind]).join(', ');

// Ответ на загруженный счёт. mode: new | updated (была ручная запись) | duplicate (такой уже есть).
export function formatInvoiceAck(inv, st, { mode = 'new', existing = null } = {}) {
  const title = monthTitle(startOfKey(inv.month));
  const head = {
    new: `📄 <b>Счёт принят:</b> ${KINDS[inv.kind]} за ${title}`,
    updated: `📄 <b>Счёт принят:</b> ${KINDS[inv.kind]} за ${title} — дополнил запись, введённую вручную`,
    duplicate: `♻️ <b>Уже есть</b> ${KINDS[inv.kind]} за ${title}${existing && Math.abs(existing.amount - inv.amount) > 0.005 ? ` на ${nf2.format(existing.amount)} ₽ — этот счёт не добавил. Если он исправленный, ответь «удалить» на старый и загрузи снова` : ''}`,
  }[mode];
  const lines = [head];
  lines.push(`💰 ${nf2.format(inv.amount)} ₽${inv.kwh != null ? ` · ${nf2.format(inv.kwh)} кВт⋅ч` : ''}${inv.number ? ` · №${esc(inv.number)}` : ''}`);
  lines.push(`🧾 За ${title}: ${st.items.map((i) => `${{ ok: '✅', missing: '❌', waiting: '⏳', none: '⚪' }[i.state]} ${KINDS[i.kind]}`).join(' · ')}`);
  if (st.missing.length) lines.push(`⚠️ Не хватает: ${missingText(st)}`);
  else if (st.complete) lines.push('✅ Все счета за месяц на месте');
  return lines.join('\n');
}

export const UNRECOGNIZED = '❓ <b>Не смог распознать счёт.</b> Ответь на это сообщение текстом, например:\n<code>30% октябрь 2026 13109,46</code>\n<code>окончательный сентябрь 2026 4321,10</code>\n<code>пени сентябрь 2026 66,43</code>';

// Кнопки по месяцам: последние 12, по три в ряд; ✅ — все счета есть, ⚠️ — каких-то не хватает.
export function monthsKeyboard(invoices, now = Date.now()) {
  const SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const buttons = [];
  // окно — 12 месяцев до текущего; если уже есть счёт за следующий месяц, сдвигаем на него
  const ahead = invoices.some((i) => i.month > monthKey(monthStart(now))) ? 1 : 0;
  for (let n = 11 - ahead; n >= -ahead; n--) {
    const s = monthStart(now, -n);
    const key = monthKey(s);
    const st = monthInvoices(invoices, key, now);
    const d = new Date(s + MSK);
    const mark = st.complete ? ' ✅' : st.missing.length ? ' ⚠️' : '';
    buttons.push({ text: `${SHORT[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}${mark}`, callback_data: `m:${key}` });
  }
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  return { inline_keyboard: rows };
}

export const MENU_TEXT = '📅 <b>Статистика по месяцам</b>\nНажми месяц — покажу выручку, зарядки, счета ТНС энерго и прибыль.\n✅ — все счета на месте · ⚠️ — какого-то счёта не хватает';

// Полная статистика месяца: зарядки из IT Charge + счета ТНС + прибыль.
export function formatMonthStats({ cur, prev, mStart, mEnd }, invoices, now = Date.now()) {
  const key = monthKey(mStart);
  const done = doneIn(cur, mStart, mEnd);
  const rub = done.reduce((a, r) => a + (r.invoice?.amount ?? r.payment?.amount ?? 0), 0);
  const kwh = done.reduce((a, r) => a + r.totalKW, 0);
  const title = monthTitle(mStart);
  const lines = [`📊 <b>${title[0].toUpperCase() + title.slice(1)} — полная статистика</b>`];
  // счёт на аванс 30% выставляют 1-го, поэтому следующий месяц может быть в меню раньше, чем начался
  const future = mStart > now;
  if (future) lines.push('<i>месяц ещё не начался — пока только счета</i>');
  else if (mEnd > now) lines.push(`<i>месяц ещё идёт — данные по ${dateRu(now)}</i>`);
  if (!future) lines.push(`💰 Выручка: <b>${nf2.format(rub)} ₽</b> · ${done.length} ${plural(done.length, 'зарядка', 'зарядки', 'зарядок')} · ${nf0.format(kwh)} кВт⋅ч`);
  const byStation = new Map();
  for (const r of done) {
    const a = byStation.get(r.chargingStation?.name) ?? { rub: 0, kwh: 0, n: 0 };
    a.rub += r.invoice?.amount ?? r.payment?.amount ?? 0;
    a.kwh += r.totalKW;
    a.n++;
    byStation.set(r.chargingStation?.name, a);
  }
  if (byStation.size > 1 && !future) for (const [name, a] of [...byStation].sort((x, y) => y[1].rub - x[1].rub)) lines.push(`• ${esc(shortStation(name))} — ${nf2.format(a.rub)} ₽ · ${a.n} · ${nf0.format(a.kwh)} кВт⋅ч`);
  if (done.length) {
    const counts = new Map(STOP_GROUPS.map(([k]) => [k, 0]));
    let other = 0;
    for (const r of done) counts.has(r.stopInitiator) ? counts.set(r.stopInitiator, counts.get(r.stopInitiator) + 1) : other++;
    const pct = (n) => `${Math.round((n / done.length) * 100)}%`;
    const parts = STOP_GROUPS.map(([k, label]) => `${label.replace(' (машина зарядилась)', '')} ${pct(counts.get(k))}`);
    if (other) parts.push(`прочее ${pct(other)}`);
    lines.push(`🛑 Кто остановил: ${parts.join(' · ')}`);
  }
  if (prev.length && kwh > 0 && !future) {
    lines.push(`📈 кВт⋅ч к прошлым годам: ${prev.map((p) => {
      const d = (kwh / p.kwh - 1) * 100;
      return `${new Date(p.start + MSK).getUTCFullYear()} ${Math.abs(d) < 0.5 ? '•' : d > 0 ? '▲ +' : '▼ −'}${nf0.format(Math.abs(d))}%`;
    }).join(' · ')}`);
  }

  // счета ТНС энерго
  const st = monthInvoices(invoices, key, now);
  lines.push('', '⚡ <b>Счета ТНС энерго</b>');
  for (const i of st.items) {
    if (i.inv) lines.push(`✅ ${KINDS[i.kind]} — ${nf2.format(i.inv.amount)} ₽${i.inv.kwh != null ? ` · ${nf2.format(i.inv.kwh)} кВт⋅ч` : ''}`);
    else if (i.state === 'missing') lines.push(`❌ ${KINDS[i.kind]} — нет счёта (оплата до ${dateRu(i.due)})`);
    else if (i.state === 'waiting') lines.push(`⏳ ${KINDS[i.kind]} — ещё не выставлен`);
  }
  if (!st.tracking && !st.items.some((i) => i.inv)) lines.push('⚪ счета за этот месяц не загружены');
  const pen = st.penalties.reduce((a, i) => a + i.amount, 0);
  if (st.penalties.length) lines.push(`💸 пени — ${nf2.format(pen)} ₽`);
  if (future) return lines.join('\n');

  // прибыль: электричество по счетам, если комплект полный; иначе — оценка по отпущенным кВт⋅ч
  const tariffInv = st.items.find((i) => i.inv?.tariff)?.inv;
  const tariffVat = tariffInv ? tariffInv.amount / tariffInv.kwh : DEFAULT_TARIFF_VAT;
  const billed = st.items.reduce((a, i) => a + (i.inv?.amount ?? 0), 0);
  const electricity = st.complete ? billed : kwh * tariffVat;
  const fee = rub * IT_CHARGE_FEE;
  const fixed = FIXED_MONTH * Math.min(1, Math.max(0, (Math.min(now, mEnd) - mStart) / (mEnd - mStart)));
  const profit = rub - electricity - fee - fixed - pen;
  lines.push('', '🧮 <b>Прибыль</b>');
  lines.push(`выручка ${nf0.format(rub)} − электричество ${st.complete ? '' : '≈ '}${nf0.format(electricity)} − комиссия IT Charge ${nf0.format(fee)} − ИП и связь ${nf0.format(fixed)}${pen ? ` − пени ${nf0.format(pen)}` : ''}`);
  lines.push(`= <b>${st.complete ? '' : '≈ '}${nf0.format(profit)} ₽</b>`);
  if (!st.complete) {
    lines.push(`<i>электричество оценено по отпущенным кВт⋅ч × ${nf2.format(tariffVat)} ₽${billed ? `; по счетам уже ${nf0.format(billed)} ₽` : ''}</i>`);
  }
  if (st.missing.length) lines.push('', `⚠️ <b>Не хватает:</b> ${missingText(st)}`);
  return lines.join('\n');
}
