// Счета ТНС энерго за электричество: распознавание, комплект за месяц (аванс 30%,
// аванс 40%, окончательный), пени и полная статистика месяца для кнопок в канале.
import { MONTH_NAMES, monthTitle, monthStart, monthKey, doneIn, STOP_GROUPS, shortStation, IT_CHARGE_FEE } from './core.mjs';

// Расходы помимо электричества (со слов владельца): комиссия IT Charge и постоянные.
const FIXED_MONTH = 50000 / 12 + 200; // ИП 50 тыс. ₽ в год + связь 200 ₽ в месяц
const DEFAULT_TARIFF_VAT = 13.34; // ₽/кВт⋅ч с НДС, если в счетах месяца тарифа нет
const VAT = 0.22;

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

// Строки PDF → счета. ТНС присылает пакетом: окончательный за месяц, аванс 40% и 30% на следующие, УПД
// и ведомость; каждый счёт начинается со строки «СЧЕТ № …». Отдельный счёт на пени — так же, один в файле.
// Каждый счёт: { number, issued, kind, month: 'YYYY-MM', amount, kwh, tariff } (+ id у пеней из окончательного).
export function parseInvoices(lines) {
  if (!/ТНС энерго|электроэнерги/i.test(lines.join('\n'))) return [];
  const starts = lines.flatMap((l, i) => (/^СЧЕТ(\s|$)/.test(l.trim()) ? [i] : []));
  const blocks = starts.length > 1 ? starts.map((st, k) => lines.slice(st, starts[k + 1])) : [lines];
  const invs = blocks.flatMap((b) => {
    // УПД и ведомость идут после последнего счёта — в его разбор не берём
    const end = b.findIndex((l) => /^(Универсальный|Ведомость электропотребления)/.test(l.trim()));
    return parseOne(end > 0 ? b.slice(0, end) : b);
  });
  // счёт общий на обе станции; ведомость делит его по точкам учёта — кладём её к окончательному за тот же месяц
  const sheet = parseSheet(lines);
  const fin = sheet && invs.find((i) => i.kind === 'final' && i.month === sheet.month);
  if (fin) fin.meters = sheet.meters;
  return invs;
}

// Ведомость электропотребления: строка точки учёта —
// «128000028373  47684209  31  150  1929  1981  OUT  52  60  3 120  НН  Первая  3 120  40947,17»
// (номер точки, …, макс. мощность, показания, тип, разность, коэффициент, расход, уровень напряжения, …, объём, сумма с НДС).
function parseSheet(lines) {
  const at = lines.findIndex((l) => /^Ведомость электропотребления/.test(l.trim()));
  if (at < 0) return null;
  const rest = lines.slice(at);
  const mm = rest.join('\n').match(/Месяц:\s*([А-Яа-яё]+)\s+(\d{4})/);
  if (!mm || monthIndex(mm[1]) < 0) return null;
  const meters = [];
  for (const l of rest) {
    const cells = l.trim().split(/\s{2,}/);
    if (!/^\d{12}$/.test(cells[0])) continue;
    const num = (c) => (/^-?[\d\s]+(,\d+)?$/.test(c ?? '') ? ruNum(c) : NaN);
    const kwh = num(cells.at(-2));
    const rub = num(cells.at(-1));
    // мощность — за три колонки до типа показаний (OUT): «… 150  1929  1981  OUT»
    const type = cells.findIndex((c) => /^[A-Z]{2,4}$/.test(c));
    const power = type > 3 ? num(cells[type - 3]) : NaN;
    if (!Number.isNaN(kwh) && !Number.isNaN(rub)) meters.push({ point: cells[0], power: Number.isNaN(power) ? null : power, kwh, rub });
  }
  return meters.length ? { month: keyOf(Number(mm[2]), monthIndex(mm[1])), meters } : null;
}

// Числа из строки таблицы, разбитой на колонки двойными пробелами (номер строки «1» в начале — не число таблицы).
const rowNums = (row) => row.split(/\s{2,}/).slice(1).filter((c) => /^-?[\d\s]+(,\d+)?$/.test(c.trim())).map(ruNum).filter((x) => !Number.isNaN(x));

function parseOne(lines) {
  const text = lines.join('\n');
  const numM = text.match(/№\s*(\d{6,}\/\d+)\s+от\s+(\d{2})\.(\d{2})\.(\d{4})/);
  if (!numM) return [];
  const issued = `${numM[4]}-${numM[3]}-${numM[2]}`;
  const inv = { number: numM[1], issued, amount: null, kwh: null, tariff: null };
  const payM = text.match(/К оплате:?\s*(-?[\d\s]+,\d{2})\s*руб/i);
  if (/оплату\s+пеней/i.test(text)) {
    // пени относим к месяцу, в котором выставлен счёт
    return payM ? [{ ...inv, amount: ruNum(payM[1]), kind: 'penalty', month: issued.slice(0, 7) }] : [];
  }
  const per = text.match(/(?:(\d{2})\s*%\s*)?за\s+([А-Яа-яё]+)\s+(\d{4})\s*г/i);
  if (!per || monthIndex(per[2]) < 0) return [];
  const kind = per[1] === '30' ? 'adv30' : per[1] === '40' ? 'adv40' : per[1] ? null : 'final';
  if (!kind) return [];
  const month = keyOf(Number(per[3]), monthIndex(per[2]));
  // строка с энергией: «1  НН: электроэнергия … (менее 670 кВт)  982,89  10,93252  10 745,46  2 364,00  13 109,46»
  const row = lines.find((l) => /электроэнергия/i.test(l) && l.split(/\s{2,}/).length >= 5);
  if (row) {
    const vals = rowNums(row);
    if (vals.length >= 2) [inv.kwh, inv.tariff] = vals;
  }
  if (kind !== 'final') return payM ? [{ ...inv, amount: ruNum(payM[1]), kind, month }] : [];
  // окончательный: «Итого к оплате по счёту» — остаток после авансов (последняя колонка строки «Электроэнергия»),
  // объём — по счётчику за весь месяц; пени, начисленные в этом месяце, — в той же таблице
  const debt = lines.find((l) => /^\d+\s+Электроэнергия(\s|$)/.test(l.trim()));
  const totalM = text.match(/Всего с НДС:?\s*(-?[\d\s]+,\d{2})/i);
  const amount = debt ? rowNums(debt).at(-1) : totalM ? ruNum(totalM[1]) : undefined;
  if (amount == null) return [];
  const out = [{ ...inv, amount, kind, month }];
  const peni = lines.find((l) => /^\d+\s+ПЕНИ(\s|$)/i.test(l.trim()));
  const accrued = peni ? rowNums(peni)[1] : 0; // колонки: долг на начало, начислено, перерасчёт, оплачено, …
  if (accrued > 0) out.push({ id: `${numM[1]}-пени`, number: numM[1], issued, amount: accrued, kwh: null, tariff: null, kind: 'penalty', month });
  return out;
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

const round2 = (x) => Math.round(x * 100) / 100;
// Начислено за месяц по окончательному счёту: объём по счётчику × тариф, плюс НДС.
const monthCharge = (inv) => (inv?.kind === 'final' && inv.kwh && inv.tariff ? round2(round2(inv.kwh * inv.tariff) * (1 + VAT)) : null);
// Свет за месяц по счетам: окончательный из PDF (весь месяц по счётчику), иначе сумма полного комплекта; null — счетов не хватает.
const monthElectricity = (st) => monthCharge(st.items.find((i) => i.kind === 'final').inv)
  ?? (st.complete ? st.items.reduce((a, i) => a + i.inv.amount, 0) : null);

// Сколько стоит свет на 1 кВт⋅ч, отпущенный машинам: начислено ТНС ÷ отпущено по IT Charge за месяцы,
// где счета известны полностью, — так в цене сразу НДС и потери станции (по счётчику всегда больше, чем машинам).
// monthKwh — { 'YYYY-MM': кВт⋅ч }. Если таких месяцев нет — тариф из последнего счёта с НДС, без потерь.
export function electricityPerKwh(invoices, monthKwh = {}) {
  let rub = 0;
  let kwh = 0;
  const months = [];
  for (const [key, k] of Object.entries(monthKwh)) {
    const e = k > 0 ? monthElectricity(monthInvoices(invoices, key)) : null;
    if (e == null) continue;
    rub += e;
    kwh += k;
    months.push(key);
  }
  if (kwh > 0) return { perKwh: rub / kwh, months: months.sort() };
  const last = invoices.filter((i) => i.tariff).sort((a, b) => b.month.localeCompare(a.month))[0];
  return { perKwh: last ? last.tariff * (1 + VAT) : DEFAULT_TARIFF_VAT, months: [] };
}

const STATE_ICON = { ok: '✅', missing: '❌', waiting: '⏳', none: '⚪' };
const invoiceSummary = (inv) => {
  const charge = monthCharge(inv);
  if (charge != null) return `к оплате ${nf2.format(inv.amount)} ₽ · за месяц начислено ${nf2.format(charge)} ₽ за ${nf2.format(inv.kwh)} кВт⋅ч по счётчикам обеих станций`;
  return `${nf2.format(inv.amount)} ₽${inv.kwh != null ? ` · ${nf2.format(inv.kwh)} кВт⋅ч` : ''}`;
};
const updatedNote = ({ mode, existing, inv }) => (mode !== 'updated' ? ''
  : ` — дополнил запись, введённую вручную${Math.abs(existing.amount - inv.amount) > 0.005 ? ` (там было ${nf2.format(existing.amount)} ₽)` : ''}`);

// Ответ на загруженный файл. results: [{ inv, mode: new | updated (была ручная запись) | duplicate, existing }],
// statuses: месяц → monthInvoices(…) для месяцев из файла.
export function formatInvoiceAck(results, statuses) {
  const lines = [];
  const titleOf = (inv) => monthTitle(startOfKey(inv.month));
  if (results.length === 1) {
    const r = results[0];
    const { inv, existing } = r;
    lines.push(r.mode === 'duplicate'
      ? `♻️ <b>Уже есть</b> ${KINDS[inv.kind]} за ${titleOf(inv)}${existing && Math.abs(existing.amount - inv.amount) > 0.005 ? ` на ${nf2.format(existing.amount)} ₽ — этот счёт не добавил. Если он исправленный, ответь «удалить» на старый и загрузи снова` : ''}`
      : `📄 <b>Счёт принят:</b> ${KINDS[inv.kind]} за ${titleOf(inv)}${updatedNote(r)}`);
    lines.push(`💰 ${invoiceSummary(inv)}${inv.number ? ` · №${esc(inv.number)}` : ''}`);
  } else {
    const n = results.length;
    const fresh = results.filter((r) => r.mode !== 'duplicate').length;
    lines.push(`📄 <b>В файле ${n} ${plural(n, 'счёт', 'счёта', 'счетов')}</b>${fresh < n ? ` · ${fresh ? `новых ${fresh}` : 'все уже были'}` : ''}`);
    for (const r of results) {
      const dup = r.mode === 'duplicate' ? ` — уже был${Math.abs(r.existing.amount - r.inv.amount) > 0.005 ? ` на ${nf2.format(r.existing.amount)} ₽, не добавил` : ''}` : '';
      lines.push(`${r.mode === 'duplicate' ? '♻️' : '✅'} ${KINDS[r.inv.kind]} за ${titleOf(r.inv)} — ${invoiceSummary(r.inv)}${dup}${updatedNote(r)}`);
    }
  }
  const sts = [...statuses.values()];
  for (const st of sts) {
    const title = monthTitle(startOfKey(st.key));
    lines.push(`🧾 За ${title}: ${st.items.map((i) => `${STATE_ICON[i.state]} ${KINDS[i.kind]}`).join(' · ')}`);
    if (st.missing.length) lines.push(`⚠️ Не хватает${sts.length > 1 ? ` за ${title}` : ''}: ${missingText(st)}`);
    else if (st.complete && sts.length === 1) lines.push('✅ Все счета за месяц на месте');
  }
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
    if (i.inv) lines.push(`✅ ${KINDS[i.kind]} — ${invoiceSummary(i.inv)}`);
    else if (i.state === 'missing') lines.push(`❌ ${KINDS[i.kind]} — нет счёта (оплата до ${dateRu(i.due)})`);
    else if (i.state === 'waiting') lines.push(`⏳ ${KINDS[i.kind]} — ещё не выставлен`);
  }
  if (!st.tracking && !st.items.some((i) => i.inv)) lines.push('⚪ счета за этот месяц не загружены');
  const pen = st.penalties.reduce((a, i) => a + i.amount, 0);
  if (st.penalties.length) lines.push(`💸 пени — ${nf2.format(pen)} ₽`);
  if (future) return lines.join('\n');

  // прибыль: электричество по счетам, если они есть; иначе — оценка по отпущенным кВт⋅ч
  const fin = st.items.find((i) => i.kind === 'final').inv;
  const tariffInv = st.items.find((i) => i.inv?.tariff)?.inv;
  const tariffVat = tariffInv ? tariffInv.tariff * (1 + VAT) : DEFAULT_TARIFF_VAT;
  // точнее всего — окончательный счёт из PDF (весь месяц по счётчику), потом полный комплект счетов, иначе оценка
  const charge = monthCharge(fin);
  const billed = st.items.reduce((a, i) => a + (i.inv?.amount ?? 0), 0);
  const billedMonth = monthElectricity(st);
  const exact = billedMonth != null;
  const electricity = billedMonth ?? kwh * tariffVat;
  const fee = rub * IT_CHARGE_FEE;

  // счёт общий на обе станции; ведомость делит его по счётчикам — станцию узнаём по мощности (DC150 → 150, АС22 → 22)
  const perStation = [];
  const meters = typeof fin?.meters === 'string' ? JSON.parse(fin.meters) : fin?.meters; // из D1 приходит строкой
  if (meters?.length) {
    lines.push('🔌 Счёт общий на обе станции, по счётчикам:');
    for (const m of meters) {
      const name = [...byStation.keys()].find((n) => m.power != null && shortStation(n ?? '').replace(/\D/g, '') === String(m.power));
      const a = byStation.get(name) ?? { rub: 0, kwh: 0 };
      const label = name ? esc(shortStation(name)) : m.power != null ? `станция ${nf0.format(m.power)} кВт` : `точка ${m.point}`;
      const loss = m.kwh > 0 ? ` (разница ${nf0.format(((m.kwh - a.kwh) / m.kwh) * 100)}%)` : '';
      lines.push(`• ${label} — ${nf0.format(m.kwh)} кВт⋅ч на ${nf0.format(m.rub)} ₽ · машинам ${nf0.format(a.kwh)}${loss}`);
      perStation.push({ label, profit: a.rub - m.rub - a.rub * IT_CHARGE_FEE });
    }
  } else if (charge != null && kwh > 0) {
    const diff = fin.kwh - kwh;
    lines.push(`🔌 По счётчикам обеих станций ${nf0.format(fin.kwh)} кВт⋅ч, машинам отпущено ${nf0.format(kwh)} — разница ${nf0.format(diff)} кВт⋅ч (${nf0.format((diff / fin.kwh) * 100)}%)`);
  }

  const fixed = FIXED_MONTH * Math.min(1, Math.max(0, (Math.min(now, mEnd) - mStart) / (mEnd - mStart)));
  const profit = rub - electricity - fee - fixed - pen;
  lines.push('', '🧮 <b>Прибыль</b>');
  lines.push(`выручка ${nf0.format(rub)} − электричество ${exact ? '' : '≈ '}${nf0.format(electricity)} − комиссия IT Charge ${nf0.format(fee)} − ИП и связь ${nf0.format(fixed)}${pen ? ` − пени ${nf0.format(pen)}` : ''}`);
  lines.push(`= <b>${exact ? '' : '≈ '}${nf0.format(profit)} ₽</b>`);
  if (perStation.length > 1) {
    lines.push(`по станциям (выручка − свет − комиссия): ${perStation.map((x) => `${x.label} ${x.profit < 0 ? '−' : ''}${nf0.format(Math.abs(x.profit))} ₽`).join(' · ')}`);
  }
  if (!exact) {
    lines.push(`<i>электричество оценено по отпущенным кВт⋅ч обеих станций × ${nf2.format(tariffVat)} ₽${billed ? `; по счетам уже ${nf0.format(billed)} ₽` : ''}</i>`);
  }
  if (st.missing.length) lines.push('', `⚠️ <b>Не хватает:</b> ${missingText(st)}`);
  return lines.join('\n');
}
