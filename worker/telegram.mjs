// Обновления Telegram (вебхук): счета ТНС энерго в канале и кнопки статистики по месяцам.
import { normalizeChatId, tgCall, itchargeClient, monthData, monthTitle } from '../notifier/core.mjs';
import { pdfLines } from '../notifier/pdf.mjs';
import { parseInvoice, parseManual, monthInvoices, formatInvoiceAck, formatMonthStats, monthsKeyboard, MENU_TEXT, UNRECOGNIZED, KINDS } from '../notifier/invoices.mjs';
import { getKv, setKv } from './db.mjs';

const MAX_ATTEMPTS = 3;
const CLAIM_TTL = 120e3;
const MSK = 3 * 3600e3;

// FlateDecode в воркере — встроенный DecompressionStream («deflate» = zlib-формат, как в PDF)
const inflate = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
const startOfKey = (key) => {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, 1) - MSK;
};

const bot = (env) => env.TELEGRAM_BOT_TOKEN.trim();
const tg = (env, method, payload) => tgCall(bot(env), method, payload);
const send = (env, chat, text, extra = {}) => tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
const replyTo = (msgId) => ({ reply_parameters: { message_id: msgId, allow_sending_without_reply: true } });

function isOurChat(env, chat) {
  const id = normalizeChatId(env.TELEGRAM_CHAT_ID);
  return Boolean(chat) && (String(chat.id) === id || (chat.username && `@${chat.username}`.toLowerCase() === id.toLowerCase()));
}

async function loadInvoices(db) {
  const { results } = await db.prepare('SELECT id, month, kind, amount, kwh, tariff, number, issued, doc_msg, ack_msg FROM invoices').all();
  return results;
}

const statsButtons = (month) => ({ inline_keyboard: [[{ text: `📊 ${monthTitle(startOfKey(month))}`, callback_data: `m:${month}` }, { text: '📅 Все месяцы', callback_data: 'menu' }]] });

export async function handleUpdate(env, update, ctx) {
  const post = update.channel_post;
  if (post && isOurChat(env, post.chat)) {
    const doc = post.document;
    if (doc && (/pdf/i.test(doc.mime_type ?? '') || /\.pdf$/i.test(doc.file_name ?? ''))) return onDocument(env, post, ctx);
    if (post.text) return onText(env, post);
    return;
  }
  const cb = update.callback_query;
  if (cb && isOurChat(env, cb.message?.chat)) return onCallback(env, cb);
}

// ---------- PDF счетов ----------

async function onDocument(env, post, ctx) {
  await env.DB.prepare('INSERT OR IGNORE INTO inbox (doc_msg, chat_id, file_id, file_name, attempts, added) VALUES (?1, ?2, ?3, ?4, 0, ?5)')
    .bind(post.message_id, String(post.chat.id), post.document.file_id, post.document.file_name ?? null, new Date().toISOString())
    .run();
  const work = processInbox(env, post.message_id);
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
}

// Разобрать файл из очереди. Если воркер не уложится в лимит процессора, запись останется и cron повторит.
export async function processInbox(env, docMsg) {
  const db = env.DB;
  const now = Date.now();
  const claimed = await db.prepare('UPDATE inbox SET attempts = attempts + 1, claimed = ?2 WHERE doc_msg = ?1 AND (claimed IS NULL OR claimed < ?3)')
    .bind(docMsg, now, now - CLAIM_TTL).run();
  if (claimed.meta.changes !== 1) return; // уже разбирается
  const row = await db.prepare('SELECT * FROM inbox WHERE doc_msg = ?1').bind(docMsg).first();
  if (!row) return;
  const done = () => db.prepare('DELETE FROM inbox WHERE doc_msg = ?1').bind(docMsg).run();
  if (row.attempts > MAX_ATTEMPTS) {
    await send(env, row.chat_id, UNRECOGNIZED, replyTo(docMsg));
    return done();
  }
  let inv = null;
  try {
    const f = await tg(env, 'getFile', { file_id: row.file_id });
    const res = await fetch(`https://api.telegram.org/file/bot${bot(env)}/${f.result.file_path}`);
    inv = parseInvoice(await pdfLines(new Uint8Array(await res.arrayBuffer()), inflate));
  } catch (err) {
    console.log('счёт не прочитан:', err.message);
  }
  if (!inv) {
    await send(env, row.chat_id, UNRECOGNIZED, replyTo(docMsg));
    return done();
  }
  await saveInvoice(env, inv, docMsg, row.chat_id);
  await done();
}

// Сохранить счёт и ответить в канале: принят / уже есть + чего не хватает за месяц.
async function saveInvoice(env, inv, docMsg, chat) {
  const db = env.DB;
  const id = inv.number ?? `manual-${docMsg}`;
  const ins = await db.prepare('INSERT OR IGNORE INTO invoices (id, month, kind, amount, kwh, tariff, number, issued, doc_msg, added) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
    .bind(id, inv.month, inv.kind, inv.amount, inv.kwh, inv.tariff, inv.number, inv.issued, docMsg, new Date().toISOString())
    .run();
  const duplicate = ins.meta.changes !== 1;
  const st = monthInvoices(await loadInvoices(db), inv.month);
  const r = await send(env, chat, formatInvoiceAck(inv, st, { duplicate }), { ...replyTo(docMsg), reply_markup: statsButtons(inv.month) });
  if (!duplicate && r.ok) await db.prepare('UPDATE invoices SET ack_msg = ?2 WHERE id = ?1').bind(id, r.result.message_id).run();
}

// ---------- текст в канале: команды, ручной ввод, удаление ----------

async function onText(env, post) {
  const db = env.DB;
  const text = post.text.trim();
  const reply = post.reply_to_message;
  if (reply) {
    if (/^удал/i.test(text)) {
      const inv = await db.prepare('SELECT * FROM invoices WHERE ack_msg = ?1').bind(reply.message_id).first();
      if (!inv) return;
      await db.prepare('DELETE FROM invoices WHERE id = ?1').bind(inv.id).run();
      return send(env, post.chat.id, `🗑 Счёт удалён: ${KINDS[inv.kind]} за ${monthTitle(startOfKey(inv.month))}, ${inv.amount.toLocaleString('ru-RU')} ₽`, { ...replyTo(post.message_id), reply_markup: statsButtons(inv.month) });
    }
    if ((reply.text ?? '').startsWith('❓')) {
      const inv = parseManual(text);
      if (!inv) return send(env, post.chat.id, 'Не понял. Пример: <code>30% октябрь 2026 13109,46</code>', replyTo(post.message_id));
      return saveInvoice(env, inv, post.message_id, post.chat.id);
    }
    return;
  }
  if (/^\/?(stats|menu|статистика|итоги|месяцы|счета)\b/i.test(text)) {
    await send(env, post.chat.id, MENU_TEXT, { reply_markup: monthsKeyboard(await loadInvoices(db)) });
    await tg(env, 'deleteMessage', { chat_id: post.chat.id, message_id: post.message_id }); // если у бота есть право удалять
  }
}

// ---------- кнопки ----------

async function onCallback(env, cb) {
  const db = env.DB;
  const msg = cb.message;
  const data = cb.data ?? '';
  if (data === 'menu') {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
    const kb = monthsKeyboard(await loadInvoices(db));
    // меню и статистику листаем в одном сообщении; из ответа на счёт — новым сообщением
    if (/^(📅|📊)/.test(msg.text ?? '')) return tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: MENU_TEXT, parse_mode: 'HTML', reply_markup: kb });
    return send(env, msg.chat.id, MENU_TEXT, { reply_markup: kb });
  }
  const m = data.match(/^m:(\d{4}-\d{2})$/);
  if (!m) return tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Считаю…' });
  const saved = await getKv(db, 'token');
  const client = itchargeClient(env, saved);
  let text;
  try {
    text = formatMonthStats(await monthData(client.withToken, startOfKey(m[1])), await loadInvoices(db));
  } catch (err) {
    text = `⚠️ Не получилось собрать статистику: ${err.message}`;
  }
  if (client.token() && client.token() !== saved) await setKv(db, 'token', client.token());
  const back = { inline_keyboard: [[{ text: '◀️ Все месяцы', callback_data: 'menu' }]] };
  if (/^(📅|📊)/.test(msg.text ?? '')) return tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: back });
  return send(env, msg.chat.id, text, { reply_markup: back });
}

// Для cron: доразобрать один зависший файл из очереди.
export async function retryInbox(env) {
  const row = await env.DB.prepare('SELECT doc_msg FROM inbox WHERE claimed IS NULL OR claimed < ?1 ORDER BY added LIMIT 1').bind(Date.now() - CLAIM_TTL).first();
  if (row) await processInbox(env, row.doc_msg);
}

export async function parseInvoicePdf(bytes) {
  const lines = await pdfLines(bytes, inflate);
  return { invoice: parseInvoice(lines), lines: lines.length };
}

export async function postMenu(env) {
  return send(env, normalizeChatId(env.TELEGRAM_CHAT_ID), MENU_TEXT, { reply_markup: monthsKeyboard(await loadInvoices(env.DB)) });
}

export async function setWebhook(env, origin) {
  return tg(env, 'setWebhook', { url: `${origin}/tg`, secret_token: env.TG_WEBHOOK_SECRET, allowed_updates: ['channel_post', 'callback_query'] });
}
