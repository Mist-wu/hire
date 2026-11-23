-- 令牌绑定资源（RFC 8707）。之前签发的留空，按默认资源处理
ALTER TABLE auth_codes ADD COLUMN resource TEXT;
ALTER TABLE device_requests ADD COLUMN resource TEXT;
ALTER TABLE tokens ADD COLUMN resource TEXT;

-- 订阅推送过哪些岗位。事件 30 天后会被清理，靠这张表保证同一个岗位只通知一次
CREATE TABLE job_notifications (
  account_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, job_id)
);
INSERT OR IGNORE INTO job_notifications (account_id, job_id, created_at)
  SELECT account_id, json_extract(payload, '$.job_id'), MIN(created_at) FROM events
  WHERE type = 'job.matched' GROUP BY account_id, json_extract(payload, '$.job_id');

-- 订阅游标带上岗位编号，同一时刻开放的岗位翻页时不会漏
ALTER TABLE subscriptions ADD COLUMN cursor_job_id TEXT NOT NULL DEFAULT '';

-- 订阅条件按键名排序后存，同一账号不能有两个条件相同的订阅
UPDATE subscriptions SET filters = (
  SELECT json_group_object(key, CASE
    WHEN type IN ('array', 'object') THEN json(value)
    WHEN type = 'true' THEN json('true')
    WHEN type = 'false' THEN json('false')
    ELSE value END)
  FROM (SELECT key, value, type FROM json_each(subscriptions.filters) ORDER BY key)
);
-- 条件相同的订阅只留最早建的那个，进度取其中最靠后的
UPDATE subscriptions SET cursor_at = (
  SELECT MAX(s.cursor_at) FROM subscriptions s
  WHERE s.account_id = subscriptions.account_id AND s.filters = subscriptions.filters
);
DELETE FROM subscriptions WHERE EXISTS (
  SELECT 1 FROM subscriptions s
  WHERE s.account_id = subscriptions.account_id AND s.filters = subscriptions.filters
    AND (s.created_at < subscriptions.created_at OR (s.created_at = subscriptions.created_at AND s.id < subscriptions.id))
);
CREATE UNIQUE INDEX subscriptions_filters ON subscriptions (account_id, filters);
