-- Состояние уведомлений: state (JSON), token (IT Charge), lastRun, lock
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
