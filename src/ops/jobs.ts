import type { Ctx } from "../env";
import { HireError, invalid, notFound } from "../errors";
import { hitRate, limits } from "../quota";
import { defineOp } from "../registry";
import {
  CompanyInput,
  EmptyInput,
  JobCloseInput,
  JobCreateInput,
  JobFields,
  JobGetInput,
  JobUpdateInput,
  JobsSearchInput,
  checkJob,
  parseInput,
} from "../schemas";
import { addCursor, addKeyword, paginate, placeholders, type Where } from "../search";
import { ACTIVE_STATUSES, CATEGORY_NAMES, DEGREE_RANK, type Degree } from "../taxonomy";
import { newId, nowIso, parseJson, randomHex } from "../util";

export interface CompanyRow {
  id: string;
  owner_account_id: string;
  name: string;
  industry: string | null;
  scale: string | null;
  stage: string | null;
  website: string | null;
  intro: string | null;
  verified: number;
  contact_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  company_id: string;
  title: string;
  recruit_type: string;
  category: string;
  cities: string;
  remote: number;
  teams: string;
  experience: string;
  degree: string;
  grad_years: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_unit: string | null;
  salary_months: number | null;
  salary_negotiable: number;
  days_per_week: number | null;
  min_months: number | null;
  convertible: number | null;
  duties: string;
  requirements: string;
  bonus: string | null;
  skills: string;
  headcount: number | null;
  deadline: string | null;
  status: string;
  source_url: string | null;
  custom_fields: string;
  created_at: string;
  updated_at: string;
}

export function companyToApi(row: CompanyRow, opts: { withContact?: boolean } = {}) {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    scale: row.scale,
    stage: row.stage,
    website: row.website,
    intro: row.intro,
    verified: row.verified === 1,
    ...(opts.withContact ? { contact_email: row.contact_email } : {}),
  };
}

function jobFieldsFromRow(row: JobRow): JobFields {
  return {
    title: row.title,
    recruit_type: row.recruit_type as JobFields["recruit_type"],
    category: row.category,
    cities: parseJson<string[]>(row.cities, []),
    remote: row.remote === 1,
    teams: parseJson<string[]>(row.teams, []),
    experience: row.experience as JobFields["experience"],
    degree: row.degree as JobFields["degree"],
    grad_years: parseJson<number[]>(row.grad_years, []),
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    salary_unit: row.salary_unit as JobFields["salary_unit"],
    salary_months: row.salary_months,
    salary_negotiable: row.salary_negotiable === 1,
    days_per_week: row.days_per_week,
    min_months: row.min_months,
    convertible: row.convertible == null ? null : row.convertible === 1,
    duties: row.duties,
    requirements: row.requirements,
    bonus: row.bonus,
    skills: parseJson<string[]>(row.skills, []),
    headcount: row.headcount,
    deadline: row.deadline,
    source_url: row.source_url,
    custom_fields: parseJson<Record<string, string>>(row.custom_fields, {}),
  };
}

export function jobToApi(row: JobRow, company: CompanyRow) {
  return {
    id: row.id,
    status: row.status,
    company: companyToApi(company),
    ...jobFieldsFromRow(row),
    category_name: CATEGORY_NAMES[row.category] ?? row.category,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function jobSummary(row: JobRow & { company_name: string }) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    company_id: row.company_id,
    company_name: row.company_name,
    recruit_type: row.recruit_type,
    category: row.category,
    cities: parseJson<string[]>(row.cities, []),
    remote: row.remote === 1,
    experience: row.experience,
    degree: row.degree,
    grad_years: parseJson<number[]>(row.grad_years, []),
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    salary_unit: row.salary_unit,
    salary_negotiable: row.salary_negotiable === 1,
    days_per_week: row.days_per_week,
    min_months: row.min_months,
    skills: parseJson<string[]>(row.skills, []),
    updated_at: row.updated_at,
  };
}

export async function primaryCompany(db: D1Database, accountId: string): Promise<CompanyRow | null> {
  return db
    .prepare("SELECT * FROM companies WHERE owner_account_id = ? ORDER BY created_at, id LIMIT 1")
    .bind(accountId)
    .first<CompanyRow>();
}

/** 取岗位和它的公司。ownerId 传了就要求岗位属于这个账号。 */
export async function loadJob(
  db: D1Database,
  jobId: string,
  ownerId?: string,
): Promise<{ job: JobRow; company: CompanyRow }> {
  const job = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
  if (!job) throw notFound("岗位");
  const company = await db.prepare("SELECT * FROM companies WHERE id = ?").bind(job.company_id).first<CompanyRow>();
  if (!company || (ownerId && company.owner_account_id !== ownerId)) throw notFound("岗位");
  return { job, company };
}

function jobWriteStatements(
  db: D1Database,
  id: string,
  company: CompanyRow,
  f: JobFields,
  status: string,
  createdAt: string,
  now: string,
): D1PreparedStatement[] {
  const cities = [...new Set(f.cities)];
  const skills = [...new Set((f.skills ?? []).map((s) => s.trim()))];
  const teams = f.teams ?? [];
  const gradYears = [...new Set(f.grad_years ?? [])];
  const searchText = [
    f.title,
    company.name,
    CATEGORY_NAMES[f.category] ?? "",
    cities.join(" "),
    teams.join(" "),
    skills.join(" "),
    f.duties,
    f.requirements,
    f.bonus ?? "",
  ].join("\n");
  const bool = (v: boolean | null | undefined) => (v == null ? null : v ? 1 : 0);

  const stmts = [
    db
      .prepare(
        `INSERT INTO jobs (id, company_id, title, recruit_type, category, category_l1, cities, remote, teams,
           experience, degree, degree_rank, grad_years, salary_min, salary_max, salary_unit, salary_months,
           salary_negotiable, days_per_week, min_months, convertible, duties, requirements, bonus, skills,
           headcount, deadline, status, source_url, custom_fields, search_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
           ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title, recruit_type = excluded.recruit_type, category = excluded.category,
           category_l1 = excluded.category_l1, cities = excluded.cities, remote = excluded.remote,
           teams = excluded.teams, experience = excluded.experience, degree = excluded.degree,
           degree_rank = excluded.degree_rank, grad_years = excluded.grad_years,
           salary_min = excluded.salary_min, salary_max = excluded.salary_max,
           salary_unit = excluded.salary_unit, salary_months = excluded.salary_months,
           salary_negotiable = excluded.salary_negotiable, days_per_week = excluded.days_per_week,
           min_months = excluded.min_months, convertible = excluded.convertible, duties = excluded.duties,
           requirements = excluded.requirements, bonus = excluded.bonus, skills = excluded.skills,
           headcount = excluded.headcount, deadline = excluded.deadline, status = excluded.status,
           source_url = excluded.source_url, custom_fields = excluded.custom_fields,
           search_text = excluded.search_text, updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        company.id,
        f.title,
        f.recruit_type,
        f.category,
        f.category.split(".")[0],
        JSON.stringify(cities),
        f.remote ? 1 : 0,
        JSON.stringify(teams),
        f.experience,
        f.degree,
        DEGREE_RANK[f.degree as Degree],
        JSON.stringify(gradYears),
        f.salary_min ?? null,
        f.salary_max ?? null,
        f.salary_unit ?? null,
        f.salary_months ?? null,
        f.salary_negotiable ? 1 : 0,
        f.days_per_week ?? null,
        f.min_months ?? null,
        bool(f.convertible),
        f.duties,
        f.requirements,
        f.bonus ?? null,
        JSON.stringify(skills),
        f.headcount ?? null,
        f.deadline ?? null,
        status,
        f.source_url ?? null,
        JSON.stringify(f.custom_fields ?? {}),
        searchText,
        createdAt,
        now,
      ),
    db.prepare("DELETE FROM job_cities WHERE job_id = ?").bind(id),
    db.prepare("DELETE FROM job_skills WHERE job_id = ?").bind(id),
    db.prepare("DELETE FROM job_grad_years WHERE job_id = ?").bind(id),
    db.prepare("DELETE FROM jobs_fts WHERE job_id = ?").bind(id),
    db.prepare("INSERT INTO jobs_fts (job_id, body) VALUES (?, ?)").bind(id, searchText),
  ];
  for (const city of cities) {
    stmts.push(db.prepare("INSERT INTO job_cities (job_id, city) VALUES (?, ?)").bind(id, city));
  }
  for (const skill of skills) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO job_skills (job_id, skill) VALUES (?, ?)").bind(id, skill));
  }
  for (const year of gradYears) {
    stmts.push(db.prepare("INSERT INTO job_grad_years (job_id, year) VALUES (?, ?)").bind(id, year));
  }
  return stmts;
}

async function getJob(ctx: Ctx, jobId: string) {
  const { job, company } = await loadJob(ctx.db, jobId);
  return jobToApi(job, company);
}

export const jobOps = [
  defineOp({
    name: "company_get",
    title: "查看我的公司",
    description: "招聘者查看自己名下的公司资料。还没有公司时返回 company: null，先用 company_upsert 创建。",
    method: "GET",
    path: "/company",
    scopes: ["recruiter:read"],
    readOnly: true,
    input: EmptyInput,
    handler: async (ctx) => {
      const { results } = await ctx.db
        .prepare("SELECT * FROM companies WHERE owner_account_id = ? ORDER BY created_at, id")
        .bind(ctx.auth.accountId)
        .all<CompanyRow>();
      const [first, ...rest] = results.map((row) => companyToApi(row, { withContact: true }));
      return { company: first ?? null, ...(rest.length ? { other_companies: rest } : {}) };
    },
  }),

  defineOp({
    name: "company_upsert",
    title: "创建或修改公司",
    description:
      "招聘者创建自己的公司，或修改已有公司的资料。发布岗位之前必须先有公司。只改传入的字段。所有公司都显示为“未认证”。",
    method: "PUT",
    path: "/company",
    scopes: ["recruiter:write"],
    readOnly: false,
    idempotent: true,
    input: CompanyInput,
    handler: async (ctx, input) => {
      const now = nowIso();
      const existing = await primaryCompany(ctx.db, ctx.auth.accountId);
      if (!existing) {
        if (!input.name) throw invalid([{ field: "name", message: "第一次创建公司时必须填名称。" }]);
        const id = newId("com");
        await ctx.db
          .prepare(
            `INSERT INTO companies (id, owner_account_id, name, industry, scale, stage, website, intro,
               contact_email, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            ctx.auth.accountId,
            input.name,
            input.industry ?? null,
            input.scale ?? null,
            input.stage ?? null,
            input.website ?? null,
            input.intro ?? null,
            input.contact_email ?? null,
            now,
            now,
          )
          .run();
      } else {
        const pick = <K extends keyof typeof input>(key: K, current: string | null) =>
          input[key] === undefined ? current : (input[key] as string | null);
        await ctx.db
          .prepare(
            `UPDATE companies SET name = ?, industry = ?, scale = ?, stage = ?, website = ?, intro = ?,
               contact_email = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(
            input.name ?? existing.name,
            pick("industry", existing.industry),
            pick("scale", existing.scale),
            pick("stage", existing.stage),
            pick("website", existing.website),
            pick("intro", existing.intro),
            pick("contact_email", existing.contact_email),
            now,
            existing.id,
          )
          .run();
      }
      const company = await primaryCompany(ctx.db, ctx.auth.accountId);
      return { company: companyToApi(company!, { withContact: true }) };
    },
  }),

  defineOp({
    name: "job_create",
    title: "发布岗位",
    description:
      "招聘者发布一个新岗位，发布后立即开放投递。实习岗位（intern_grad、intern_daily）必须填 days_per_week 和 min_months。不面议时必须填 salary_min、salary_max 和 salary_unit。",
    method: "POST",
    path: "/jobs",
    scopes: ["recruiter:write"],
    readOnly: false,
    input: JobCreateInput,
    handler: async (ctx, input) => {
      const { company_id, ...fields } = input;
      checkJob(fields);
      let company: CompanyRow | null;
      if (company_id) {
        company = await ctx.db
          .prepare("SELECT * FROM companies WHERE id = ? AND owner_account_id = ?")
          .bind(company_id, ctx.auth.accountId)
          .first<CompanyRow>();
        if (!company) throw notFound("公司");
      } else {
        company = await primaryCompany(ctx.db, ctx.auth.accountId);
        if (!company) {
          throw new HireError("validation_failed", "你还没有公司。先调用 company_upsert 创建公司，再发布岗位。", {
            fields: [{ field: "company_id", message: "没有可用的公司" }],
          });
        }
      }
      const id = newId("job");
      const now = nowIso();
      await ctx.db.batch(jobWriteStatements(ctx.db, id, company, fields, "open", now, now));
      return { job: await getJob(ctx, id) };
    },
  }),

  defineOp({
    name: "job_update",
    title: "修改岗位",
    description:
      "招聘者修改自己发布的岗位。只改传入的字段，数组字段整体替换，可选字段传 null 表示清空。status 可以在 open 和 paused 之间切换。已关闭的岗位不能修改。",
    method: "PATCH",
    path: "/jobs/:job_id",
    scopes: ["recruiter:write"],
    readOnly: false,
    idempotent: true,
    input: JobUpdateInput,
    handler: async (ctx, input) => {
      const { job_id, status, ...patch } = input;
      const { job, company } = await loadJob(ctx.db, job_id, ctx.auth.accountId);
      if (job.status === "closed") {
        throw new HireError("job_not_open", "这个岗位已经关闭，不能再修改。需要的话重新发布一个。", {
          current_status: job.status,
        });
      }
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const merged = parseInput(JobFields, { ...jobFieldsFromRow(job), ...defined });
      checkJob(merged);
      await ctx.db.batch(
        jobWriteStatements(ctx.db, job.id, company, merged, status ?? job.status, job.created_at, nowIso()),
      );
      return { job: await getJob(ctx, job.id) };
    },
  }),

  defineOp({
    name: "job_close",
    title: "关闭岗位",
    description:
      "招聘者关闭自己的岗位。关闭后不能再投递，也不能重新打开。这个岗位下所有还没结束的投递会变成“已关闭”，对应的求职者会收到事件。",
    method: "POST",
    path: "/jobs/:job_id/close",
    scopes: ["recruiter:write"],
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: JobCloseInput,
    handler: async (ctx, input) => {
      const { job, company } = await loadJob(ctx.db, input.job_id, ctx.auth.accountId);
      if (job.status === "closed") return { job: jobToApi(job, company), closed_applications: 0 };
      const now = nowIso();
      const { results: active } = await ctx.db
        .prepare(
          `SELECT id, candidate_id, status FROM applications
           WHERE job_id = ? AND status IN (${placeholders(ACTIVE_STATUSES.length)})`,
        )
        .bind(job.id, ...ACTIVE_STATUSES)
        .all<{ id: string; candidate_id: string; status: string }>();

      const stmts: D1PreparedStatement[] = [
        ctx.db.prepare("UPDATE jobs SET status = 'closed', updated_at = ? WHERE id = ?").bind(now, job.id),
      ];
      for (const app of active) {
        const rev = randomHex(8);
        const guard = "WHERE EXISTS (SELECT 1 FROM applications WHERE id = ? AND rev = ?)";
        stmts.push(
          ctx.db
            .prepare(
              `UPDATE applications SET status = 'closed', closed_by = 'system', ended_at = ?, rev = ?, updated_at = ?
               WHERE id = ? AND status = ?`,
            )
            .bind(now, rev, now, app.id, app.status),
          ctx.db
            .prepare(
              `INSERT INTO application_logs (application_id, actor, from_status, to_status, note, created_at)
               SELECT ?, 'system', ?, 'closed', ?, ? ${guard}`,
            )
            .bind(app.id, app.status, input.note ?? null, now, app.id, rev),
          ctx.db
            .prepare(
              `INSERT INTO events (account_id, audience, type, application_id, payload, created_at)
               SELECT ?, 'candidate', 'application.closed', ?, ?, ? ${guard}`,
            )
            .bind(
              app.candidate_id,
              app.id,
              JSON.stringify({
                job_id: job.id,
                job_title: job.title,
                counterpart: company.name,
                status: "closed",
                note: input.note ?? null,
              }),
              now,
              app.id,
              rev,
            ),
        );
      }
      // 每条投递占 3 条语句。分批提交时按 3 的倍数切，保证同一条投递的语句在同一批里
      await ctx.db.batch(stmts.slice(0, 1 + 60));
      for (let i = 61; i < stmts.length; i += 60) await ctx.db.batch(stmts.slice(i, i + 60));
      return { job: await getJob(ctx, job.id), closed_applications: active.length };
    },
  }),

  defineOp({
    name: "job_get",
    title: "查看岗位详情",
    description: "查看一个岗位的全部信息，包括公司资料、职责、要求和薪资。搜索结果只有摘要，判断是否合适前先读详情。",
    method: "GET",
    path: "/jobs/:job_id",
    scopes: ["candidate:read", "recruiter:read"],
    readOnly: true,
    input: JobGetInput,
    handler: async (ctx, input) => ({ job: await getJob(ctx, input.job_id) }),
  }),

  defineOp({
    name: "jobs_search",
    title: "搜索岗位",
    description:
      "按条件搜索开放中的岗位，返回摘要列表，按更新时间从新到旧排列。服务端只做条件过滤，不打分；合不合适要读详情后自己判断。先用城市、招聘类型、每周天数这些硬条件缩小范围，再用关键词。招聘者传 mine=true 可以列出自己名下所有状态的岗位。",
    method: "GET",
    path: "/jobs",
    scopes: ["candidate:read", "recruiter:read"],
    readOnly: true,
    input: JobsSearchInput,
    handler: async (ctx, input) => {
      if ((input.salary_min == null) !== (input.salary_unit == null)) {
        throw invalid([{ field: "salary_unit", message: "salary_min 和 salary_unit 必须一起传。" }]);
      }
      await hitRate(ctx.db, `search:${ctx.auth.accountId}`, limits(ctx.env).searchPerMin, "每分钟搜索次数");

      const where: Where = { clauses: [], params: [] };
      if (input.mine) {
        if (!ctx.auth.scopes.has("recruiter:read")) {
          throw new HireError("forbidden_scope", "mine=true 只有招聘者令牌能用，需要 recruiter:read 范围。", {
            required: ["recruiter:read"],
          });
        }
        where.clauses.push("c.owner_account_id = ?");
        where.params.push(ctx.auth.accountId);
      } else {
        where.clauses.push("j.status = 'open'");
      }
      const eq = (col: string, value: unknown) => {
        if (value === undefined) return;
        where.clauses.push(`${col} = ?`);
        where.params.push(value);
      };
      eq("j.recruit_type", input.recruit_type);
      eq("j.company_id", input.company_id);
      if (input.category) eq(input.category.includes(".") ? "j.category" : "j.category_l1", input.category);
      if (input.remote !== undefined) eq("j.remote", input.remote ? 1 : 0);
      if (input.city) {
        where.clauses.push("EXISTS (SELECT 1 FROM job_cities jc WHERE jc.job_id = j.id AND jc.city = ?)");
        where.params.push(input.city);
      }
      if (input.degree) {
        where.clauses.push("j.degree_rank <= ?");
        where.params.push(DEGREE_RANK[input.degree]);
      }
      if (input.grad_year !== undefined) {
        where.clauses.push(
          `(NOT EXISTS (SELECT 1 FROM job_grad_years g WHERE g.job_id = j.id)
            OR EXISTS (SELECT 1 FROM job_grad_years g WHERE g.job_id = j.id AND g.year = ?))`,
        );
        where.params.push(input.grad_year);
      }
      if (input.days_per_week_max !== undefined) {
        where.clauses.push("j.days_per_week <= ?");
        where.params.push(input.days_per_week_max);
      }
      if (input.min_months_max !== undefined) {
        where.clauses.push("j.min_months <= ?");
        where.params.push(input.min_months_max);
      }
      if (input.salary_min !== undefined) {
        where.clauses.push("j.salary_unit = ? AND j.salary_max >= ?");
        where.params.push(input.salary_unit, input.salary_min);
      }
      if (input.skills?.length) {
        where.clauses.push(
          `EXISTS (SELECT 1 FROM job_skills s WHERE s.job_id = j.id AND s.skill IN (${placeholders(input.skills.length)}))`,
        );
        where.params.push(...input.skills);
      }
      addKeyword(where, input.q, { fts: "jobs_fts", ftsKey: "job_id", idCol: "j.id", textCol: "j.search_text" });
      addCursor(where, input.cursor, "j.updated_at", "j.id");

      const limit = input.limit ?? 20;
      const { results } = await ctx.db
        .prepare(
          `SELECT j.*, c.name AS company_name FROM jobs j JOIN companies c ON c.id = j.company_id
           WHERE ${where.clauses.join(" AND ")}
           ORDER BY j.updated_at DESC, j.id DESC LIMIT ?`,
        )
        .bind(...where.params, limit + 1)
        .all<JobRow & { company_name: string }>();
      const { page, next_cursor } = paginate(results, limit, (row) => [row.updated_at, row.id]);
      return { jobs: page.map(jobSummary), next_cursor };
    },
  }),
];
