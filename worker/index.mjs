// Cloudflare Worker: раз в минуту проверяет IT Charge и пишет в Telegram-канал
// (логика — notifier/core.mjs). Состояние и токен IT Charge лежат в D1, в таблице kv;
// секреты заданы через `wrangler secret put`.
import { check } from '../notifier/core.mjs';

const LOCK_TTL = 120e3; // проверку дольше двух минут считаем зависшей

async function getKv(db, k) {
  const row = await db.prepare('SELECT v FROM kv WHERE k = ?1').bind(k).first();
  return row ? row.v : null;
}

async function setKv(db, k, v) {
  await db.prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
}

// Две проверки одновременно (cron и ручной запуск) отправили бы одно и то же дважды.
async function acquireLock(db, now) {
  const res = await db
    .prepare("INSERT INTO kv (k, v) VALUES ('lock', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(kv.v AS INTEGER) < ?2")
    .bind(String(now), now - LOCK_TTL)
    .run();
  return res.meta.changes === 1;
}

async function runOnce(env, { test = false } = {}) {
  const db = env.DB;
  const now = Date.now();
  if (!(await acquireLock(db, now))) return { log: 'предыдущая проверка ещё идёт — пропускаю' };
  try {
    const stateRaw = await getKv(db, 'state');
    const token = await getKv(db, 'token');
    let result;
    try {
      result = await check({ secrets: env, state: stateRaw ? JSON.parse(stateRaw) : null, token, test, now });
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
    if (result.error) throw new Error(result.error);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Ручной запуск: POST /run (?test=1 — тестовые сообщения в канал), только с ключом.
    if (url.pathname === '/run' && request.method === 'POST') {
      if (!env.ADMIN_KEY || request.headers.get('authorization') !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response('forbidden', { status: 403 });
      }
      const result = await runOnce(env, { test: url.searchParams.get('test') === '1' });
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
