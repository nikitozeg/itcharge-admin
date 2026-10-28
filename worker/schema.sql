-- Состояние уведомлений: state (JSON), token (IT Charge), lastRun, lock
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Счета ТНС энерго, загруженные в канал: id — номер счёта (или manual-<сообщение>)
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,          -- 'YYYY-MM'
  kind TEXT NOT NULL,           -- adv30 | adv40 | final | penalty
  amount REAL NOT NULL,         -- «К оплате», ₽ с НДС
  kwh REAL,
  tariff REAL,                  -- ₽/кВт⋅ч без НДС
  number TEXT,
  issued TEXT,                  -- дата счёта 'YYYY-MM-DD'
  doc_msg INTEGER,              -- сообщение с PDF в канале
  ack_msg INTEGER,              -- ответ бота «счёт принят»
  added TEXT NOT NULL,
  meters TEXT,                  -- у окончательного: JSON [{ point, power, kwh, rub }] из ведомости — по станциям
  accrued REAL                  -- у окончательного: начислено за месяц, ₽ с НДС (таблица задолженности или акт сверки)
);
-- для базы, созданной раньше: ALTER TABLE invoices ADD COLUMN meters TEXT; ALTER TABLE invoices ADD COLUMN accrued REAL;

-- Очередь PDF из канала: разбор может не уложиться в лимит процессора — тогда повтор по cron
CREATE TABLE IF NOT EXISTS inbox (
  doc_msg INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_name TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER,              -- когда взят в работу (мс), чтобы не разбирать дважды
  added TEXT NOT NULL
);
