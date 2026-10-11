-- 一个账号只能是求职者或招聘者
ALTER TABLE accounts ADD COLUMN role TEXT;
-- 事件拉到哪了，由服务端记着
ALTER TABLE accounts ADD COLUMN events_cursor INTEGER NOT NULL DEFAULT 0;

UPDATE accounts SET role = 'recruiter' WHERE id IN (SELECT owner_account_id FROM companies);
UPDATE accounts SET role = 'candidate' WHERE role IS NULL AND id IN (SELECT account_id FROM candidates);

-- 定为招聘者的账号，清掉它在求职者一侧留下的数据
DELETE FROM events WHERE application_id IN (
  SELECT id FROM applications WHERE candidate_id IN (SELECT id FROM accounts WHERE role = 'recruiter'));
DELETE FROM application_logs WHERE application_id IN (
  SELECT id FROM applications WHERE candidate_id IN (SELECT id FROM accounts WHERE role = 'recruiter'));
DELETE FROM applications WHERE candidate_id IN (SELECT id FROM accounts WHERE role = 'recruiter');
DELETE FROM candidate_cities WHERE account_id IN (SELECT id FROM accounts WHERE role = 'recruiter');
DELETE FROM candidate_skills WHERE account_id IN (SELECT id FROM accounts WHERE role = 'recruiter');
DELETE FROM candidate_recruit_types WHERE account_id IN (SELECT id FROM accounts WHERE role = 'recruiter');
DELETE FROM candidates_fts WHERE account_id IN (SELECT id FROM accounts WHERE role = 'recruiter');
DELETE FROM subscriptions WHERE account_id IN (SELECT id FROM accounts WHERE role = 'recruiter');
DELETE FROM candidates WHERE account_id IN (SELECT id FROM accounts WHERE role = 'recruiter');

-- 处理比例改成只算做出决定（邀约或拒绝），查看不算
ALTER TABLE applications RENAME COLUMN responded_at TO decided_at;
UPDATE applications SET decided_at = (
  SELECT MIN(l.created_at) FROM application_logs l
  WHERE l.application_id = applications.id AND l.actor = 'recruiter' AND l.to_status IN ('invited', 'rejected')
);

-- 不参与搜索的岗位字段
ALTER TABLE jobs DROP COLUMN teams;
ALTER TABLE jobs DROP COLUMN source_url;
ALTER TABLE jobs DROP COLUMN salary_months;
ALTER TABLE jobs DROP COLUMN custom_fields;

-- 搜索按发布时间排序，修改岗位不再改变排位
DROP INDEX jobs_listing;
CREATE INDEX jobs_listing ON jobs (status, created_at DESC, id DESC);
DROP INDEX candidates_listing;
CREATE INDEX candidates_listing ON candidates (resume_public, created_at DESC, account_id DESC);

-- 公司不能重名
CREATE UNIQUE INDEX companies_name ON companies (name COLLATE NOCASE);
