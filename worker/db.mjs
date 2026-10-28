// Простое хранилище в D1: таблица kv (состояние, токен IT Charge, отметки), счета и очередь файлов.
export async function getKv(db, k) {
  const row = await db.prepare('SELECT v FROM kv WHERE k = ?1').bind(k).first();
  return row ? row.v : null;
}

export async function setKv(db, k, v) {
  await db.prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
}
