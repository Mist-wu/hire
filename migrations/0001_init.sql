-- 账号与登录
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  secret_hash TEXT,
  name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scopes TEXT,
  resource TEXT,
  account_id TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  account_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

CREATE TABLE device_requests (
  device_hash TEXT PRIMARY KEY,
  github_device_code TEXT NOT NULL,
  scopes TEXT NOT NULL,
  poll_interval INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  client_id TEXT,
  scopes TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 公司与岗位
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  industry TEXT,
  scale TEXT,
  stage TEXT,
  website TEXT,
  intro TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  contact_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX companies_owner ON companies (owner_account_id, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  title TEXT NOT NULL,
  recruit_type TEXT NOT NULL,
  category TEXT NOT NULL,
  category_l1 TEXT NOT NULL,
  cities TEXT NOT NULL,
  remote INTEGER NOT NULL DEFAULT 0,
  teams TEXT NOT NULL DEFAULT '[]',
  experience TEXT NOT NULL,
  degree TEXT NOT NULL,
  degree_rank INTEGER NOT NULL,
  grad_years TEXT NOT NULL DEFAULT '[]',
  salary_min INTEGER,
  salary_max INTEGER,
  salary_unit TEXT,
  salary_months INTEGER,
  salary_negotiable INTEGER NOT NULL DEFAULT 0,
  days_per_week INTEGER,
  min_months INTEGER,
  convertible INTEGER,
  duties TEXT NOT NULL,
  requirements TEXT NOT NULL,
  bonus TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  headcount INTEGER,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source_url TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_listing ON jobs (status, updated_at DESC, id DESC);
CREATE INDEX jobs_company ON jobs (company_id, updated_at DESC);

CREATE TABLE job_cities (job_id TEXT NOT NULL, city TEXT NOT NULL, PRIMARY KEY (job_id, city));
CREATE INDEX job_cities_city ON job_cities (city);
CREATE TABLE job_skills (job_id TEXT NOT NULL, skill TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (job_id, skill));
CREATE INDEX job_skills_skill ON job_skills (skill);
CREATE TABLE job_grad_years (job_id TEXT NOT NULL, year INTEGER NOT NULL, PRIMARY KEY (job_id, year));

CREATE VIRTUAL TABLE jobs_fts USING fts5 (job_id UNINDEXED, body, tokenize = 'trigram');

-- 求职者
CREATE TABLE candidates (
  account_id TEXT PRIMARY KEY,
  name TEXT,
  school TEXT,
  degree TEXT,
  degree_rank INTEGER NOT NULL DEFAULT 0,
  major TEXT,
  grad_year INTEGER,
  city TEXT,
  summary TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  education TEXT NOT NULL DEFAULT '[]',
  experience TEXT NOT NULL DEFAULT '[]',
  projects TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  expectation TEXT NOT NULL DEFAULT '{}',
  days_per_week INTEGER,
  resume_public INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  email TEXT,
  pdf_key TEXT,
  pdf_name TEXT,
  pdf_size INTEGER,
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX candidates_listing ON candidates (resume_public, updated_at DESC, account_id DESC);

CREATE TABLE candidate_cities (account_id TEXT NOT NULL, city TEXT NOT NULL, PRIMARY KEY (account_id, city));
CREATE INDEX candidate_cities_city ON candidate_cities (city);
CREATE TABLE candidate_skills (account_id TEXT NOT NULL, skill TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (account_id, skill));
CREATE INDEX candidate_skills_skill ON candidate_skills (skill);
CREATE TABLE candidate_recruit_types (account_id TEXT NOT NULL, recruit_type TEXT NOT NULL, PRIMARY KEY (account_id, recruit_type));

CREATE VIRTUAL TABLE candidates_fts USING fts5 (account_id UNINDEXED, body, tokenize = 'trigram');

-- 投递
CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  status TEXT NOT NULL,
  custom_resume TEXT,
  invitation TEXT,
  chosen_slot TEXT,
  closed_by TEXT,
  ended_at TEXT,
  rev TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX applications_active ON applications (job_id, candidate_id)
  WHERE status IN ('applied', 'viewed', 'invited');
CREATE INDEX applications_candidate ON applications (candidate_id, updated_at DESC, id DESC);
CREATE INDEX applications_job ON applications (job_id, updated_at DESC, id DESC);

CREATE TABLE application_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX application_logs_app ON application_logs (application_id, id);

-- 事件与限额
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  type TEXT NOT NULL,
  application_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_account ON events (account_id, seq);

CREATE TABLE rate_counters (
  key TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);
