-- 岗位最近一次开放的时间。暂停后重开的岗位，订阅按这个时间补发
ALTER TABLE jobs ADD COLUMN opened_at TEXT;
UPDATE jobs SET opened_at = created_at;

-- 公司重名按归一化后的名字判断：去掉空白、不分大小写和全半角
ALTER TABLE companies ADD COLUMN name_key TEXT;
UPDATE companies SET name_key = lower(replace(replace(name, ' ', ''), '　', ''));
DROP INDEX companies_name;
CREATE UNIQUE INDEX companies_name_key ON companies (name_key);

-- 活跃时间加进来之前就有的资料和公司，按最后修改时间算
UPDATE candidates SET active_at = updated_at WHERE active_at IS NULL AND name IS NOT NULL;
UPDATE companies SET active_at = updated_at WHERE active_at IS NULL;
