-- 为搜索接口的排序（按 created_at 降序）添加索引，避免全表扫描后在内存中做 TEMP B-TREE 排序
CREATE INDEX jobs_search_created_at ON jobs (status, created_at DESC, id DESC);
CREATE INDEX candidates_search_created_at ON candidates (resume_public, created_at DESC, account_id DESC);
