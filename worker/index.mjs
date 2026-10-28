// Cloudflare Worker: раз в минуту проверяет IT Charge и пишет в Telegram-канал
// (логика — notifier/core.mjs), а через вебхук принимает из канала счета ТНС энерго
// и отвечает на кнопки статистики (worker/telegram.mjs). Состояние, токен IT Charge
// и счета лежат в D1; секреты заданы через `wrangler secret put`.
import { check } from '../notifier/core.mjs';
import { getKv, setKv } from './db.mjs';
import { handleUpdate, retryInbox, postMenu, setWebhook, parseInvoicePdf } from './telegram.mjs';

const LOCK_TTL = 120e3; // проверку дольше двух минут считаем зависшей

// Две проверки одновременно (cron и ручной запуск) отправили бы одно и то же дважды.
async function acquireLock(db, now) {
  const res = await db
    .prepare("INSERT INTO kv (k, v) VALUES ('lock', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(kv.v AS INTEGER) < ?2")
    .bind(String(now), now - LOCK_TTL)
    .run();
  return res.meta.changes === 1;
}

async function runOnce(env, { test = false, monthlyTest = false } = {}) {
  const db = env.DB;
  const now = Date.now();
  if (!(await acquireLock(db, now))) return { log: 'предыдущая проверка ещё идёт — пропускаю' };
  try {
    const stateRaw = await getKv(db, 'state');
    const token = await getKv(db, 'token');
    let result;
    try {
      result = await check({ secrets: env, state: stateRaw ? JSON.parse(stateRaw) : null, token, test, monthlyTest, now });
    } catch (err) {
      result = { log: 'проверка не выполнена', error: err.message };
    }
    const nextState = result.state ? JSON.stringify(result.state) : null;
    if (nextState && nextState !== stateRaw) await setKv(db, 'state', nextState);
    if (result.token && result.token !== token) await setKv(db, 'token', result.token);
    await setKv(db, 'lastRun', JSON.stringify({ at: new Date(now).toISOString(), ok: !result.error }));
    return result;
  } finally {
    await db.prepare("DELETE FROM kv WHERE k = 'lock'").run();
  }
}

export default {
  async scheduled(event, env) {
    const result = await runOnce(env);
    console.log(result.log);
    // счёт, который не успел разобраться при загрузке, — после основной проверки, чтобы её не задерживать
    await retryInbox(env).catch((err) => console.log('очередь счетов:', err.message));
    if (result.error) throw new Error(result.error);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Вебхук Telegram: счета в канале и кнопки. Секрет — в заголовке, который ставит Telegram.
    if (url.pathname === '/tg' && request.method === 'POST') {
      if (!env.TG_WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.TG_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(env, update, ctx).catch((err) => console.log('telegram:', err.message)));
      return new Response('ok');
    }

    // Ручной запуск: POST /run (?test=1 — тестовые сообщения, ?monthly=1 — пример месячного итога,
    // ?setup=webhook, ?menu=1, ?parse=1), только с ключом.
    if (url.pathname === '/run' && request.method === 'POST') {
      if (!env.ADMIN_KEY || request.headers.get('authorization') !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response('forbidden', { status: 403 });
      }
      // ?setup=webhook — подключить вебхук Telegram; ?menu=1 — выложить в канал меню с месяцами
      if (url.searchParams.get('setup') === 'webhook') return Response.json(await setWebhook(env, url.origin));
      if (url.searchParams.get('menu') === '1') return Response.json(await postMenu(env));
      // ?parse=1 с PDF в теле — проверить распознавание счёта, ничего не сохраняя
      if (url.searchParams.get('parse') === '1') return Response.json(await parseInvoicePdf(new Uint8Array(await request.arrayBuffer())));
      const result = await runOnce(env, { test: url.searchParams.get('test') === '1', monthlyTest: url.searchParams.get('monthly') === '1' });
      return Response.json({ log: result.log, error: result.error ?? null });
    }

    // Публичная страница — только время последней проверки, без данных.
    if (url.pathname === '/') {
      const last = JSON.parse((await getKv(env.DB, 'lastRun')) ?? 'null');
      const text = last ? `последняя проверка: ${last.at} · ${last.ok ? 'ок' : 'ошибка'}` : 'проверок ещё не было';
      return new Response(`itcharge-notifier\n${text}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    return new Response('not found', { status: 404 });
  },
};
