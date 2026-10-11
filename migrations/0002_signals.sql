-- 活跃度
ALTER TABLE companies ADD COLUMN active_at TEXT;
ALTER TABLE candidates ADD COLUMN active_at TEXT;

-- 筛选问题和详情读取次数
ALTER TABLE jobs ADD COLUMN questions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN detail_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE applications ADD COLUMN answers TEXT;

-- 招聘者第一次处理的时间、拒绝原因、录用内容
ALTER TABLE applications ADD COLUMN responded_at TEXT;
ALTER TABLE applications ADD COLUMN reject_reason TEXT;
ALTER TABLE applications ADD COLUMN offer TEXT;

UPDATE applications SET responded_at = (
  SELECT MIN(l.created_at) FROM application_logs l
  WHERE l.application_id = applications.id AND l.actor = 'recruiter'
) WHERE initiated_by = 'candidate';

-- 接受邀约之后还有录用环节，“已接受”不再是终态
UPDATE applications SET ended_at = NULL WHERE status = 'accepted';
DROP INDEX applications_active;
CREATE UNIQUE INDEX applications_active ON applications (job_id, candidate_id)
  WHERE status IN ('applied', 'viewed', 'invited', 'accepted', 'offered');

-- 订阅命中的事件不属于任何投递，application_id 改成可空
CREATE TABLE events_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  type TEXT NOT NULL,
  application_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO events_new (seq, account_id, audience, type, application_id, payload, created_at)
  SELECT seq, account_id, audience, type, application_id, payload, created_at FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX events_account ON events (account_id, seq);

-- 订阅搜索
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  filters TEXT NOT NULL,
  cursor_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX subscriptions_account ON subscriptions (account_id, created_at);
