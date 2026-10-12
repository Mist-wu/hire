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
  type JobFilters,
  JobGetInput,
  JobUpdateInput,
  JobsSearchInput,
  checkJob,
  parseInput,
} from "../schemas";
import { addCursor, addKeyword, paginate, placeholders, type Where } from "../search";
import { CATEGORY_NAMES, DEGREE_RANK, PENDING_STATUSES, type Degree } from "../taxonomy";
import { beijingDate, nameKey, newId, normCity, nowIso, parseJson, randomHex } from "../util";

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
  active_at: string | null;
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
  experience: string;
  degree: string;
  grad_years: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_unit: string | null;
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
  questions: string;
  detail_views: number;
  opened_at: string | null;
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
    experience: row.experience as JobFields["experience"],
    degree: row.degree as JobFields["degree"],
    grad_years: parseJson<number[]>(row.grad_years, []),
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    salary_unit: row.salary_unit as JobFields["salary_unit"],
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
    questions: parseJson<NonNullable<JobFields["questions"]>>(row.questions, []),
  };
}

export function jobToApi(row: JobRow, company: CompanyRow) {
  return {
    id: row.id,
    status: row.status,
    company: companyToApi(company),
    ...jobFieldsFromRow(row),
    category_name: CATEGORY_NAMES[row.category] ?? row.category,
    accepting: acceptsApplications(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 开放、而且没过截止日期。 */
export function acceptsApplications(job: Pick<JobRow, "status" | "deadline">): boolean {
  return job.status === "open" && (job.deadline == null || job.deadline >= beijingDate());
}

/** 搜索和订阅只看还在招的岗位。 */
export function addOpenFilter(where: Where): void {
  where.clauses.push("j.status = 'open' AND (j.deadline IS NULL OR j.deadline >= ?)");
  where.params.push(beijingDate());
}

function checkDeadline(deadline: string | null | undefined): void {
  if (deadline != null && deadline < beijingDate()) {
    throw invalid([{ field: "deadline", message: "截止日期不能在过去。" }]);
  }
}

/** 求职者和一批岗位之间最近的一条投递，用来在结果里标出“投过了”。 */
async function myApplications(ctx: Ctx, jobIds: string[]) {
  const out = new Map<string, { id: string; status: string }>();
  if (ctx.auth.role !== "candidate" || !jobIds.length) return out;
  const { results } = await ctx.db
    .prepare(
      `SELECT id, job_id, status FROM applications
       WHERE candidate_id = ? AND job_id IN (${placeholders(jobIds.length)}) ORDER BY created_at`,
    )
    .bind(ctx.auth.accountId, ...jobIds)
    .all<{ id: string; job_id: string; status: string }>();
  for (const row of results) out.set(row.job_id, { id: row.id, status: row.status });
  return out;
}

function jobSummary(row: JobRow & { company_name: string; recruiter_active_at: string | null }) {
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
    question_count: parseJson<unknown[]>(row.questions, []).length,
    recruiter_active_at: row.recruiter_active_at,
    created_at: row.created_at,
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

/** 关键词搜索用的文本。公司名也在里面，公司改名时要重算。 */
function jobSearchText(
  f: Pick<JobFields, "title" | "category" | "cities" | "skills" | "duties" | "requirements" | "bonus">,
  companyName: string,
): string {
  return [
    f.title,
    companyName,
    CATEGORY_NAMES[f.category] ?? "",
    f.cities.join(" "),
    (f.skills ?? []).join(" "),
    f.duties,
    f.requirements,
    f.bonus ?? "",
  ].join("\n");
}

function jobWriteStatements(
  db: D1Database,
  id: string,
  company: CompanyRow,
  f: JobFields,
  status: string,
  createdAt: string,
  openedAt: string,
  now: string,
): D1PreparedStatement[] {
  const cities = [...new Set(f.cities.map(normCity))];
  const skills = [...new Set((f.skills ?? []).map((s) => s.trim()))];
  const gradYears = [...new Set(f.grad_years ?? [])];
  const searchText = jobSearchText({ ...f, cities, skills }, company.name);
  const bool = (v: boolean | null | undefined) => (v == null ? null : v ? 1 : 0);

  // 这些列在修改岗位时整体覆盖；id、company_id、created_at 只在新建时写
  const columns: Record<string, unknown> = {
    title: f.title,
    recruit_type: f.recruit_type,
    category: f.category,
    category_l1: f.category.split(".")[0],
    cities: JSON.stringify(cities),
    remote: f.remote ? 1 : 0,
    experience: f.experience,
    degree: f.degree,
    degree_rank: DEGREE_RANK[f.degree as Degree],
    grad_years: JSON.stringify(gradYears),
    salary_min: f.salary_min ?? null,
    salary_max: f.salary_max ?? null,
    salary_unit: f.salary_unit ?? null,
    salary_negotiable: f.salary_negotiable ? 1 : 0,
    days_per_week: f.days_per_week ?? null,
    min_months: f.min_months ?? null,
    convertible: bool(f.convertible),
    duties: f.duties,
    requirements: f.requirements,
    bonus: f.bonus ?? null,
    skills: JSON.stringify(skills),
    headcount: f.headcount ?? null,
    deadline: f.deadline ?? null,
    status,
    opened_at: openedAt,
    questions: JSON.stringify(f.questions ?? []),
    search_text: searchText,
    updated_at: now,
  };
  const names = Object.keys(columns);

  const stmts = [
    db
      .prepare(
        `INSERT INTO jobs (id, company_id, created_at, ${names.join(", ")})
         VALUES (?, ?, ?, ${placeholders(names.length)})
         ON CONFLICT (id) DO UPDATE SET ${names.map((n) => `${n} = excluded.${n}`).join(", ")}`,
      )
      .bind(id, company.id, createdAt, ...names.map((n) => columns[n])),
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

const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** 招聘者的活跃度：最近活跃时间，以及近 90 天收到的投递里，做出决定（邀约或拒绝）的有多少。 */
async function recruiterActivity(db: D1Database, company: CompanyRow) {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(a.decided_at) AS decided,
              AVG((julianday(a.decided_at) - julianday(a.created_at)) * 24) AS avg_hours
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE j.company_id = ? AND a.initiated_by = 'candidate' AND a.created_at >= ?`,
    )
    .bind(company.id, since)
    .first<{ total: number; decided: number; avg_hours: number | null }>();
  const total = row?.total ?? 0;
  return {
    active_at: company.active_at,
    applications_90d: total,
    decision_rate: total ? Math.round(((row?.decided ?? 0) / total) * 100) / 100 : null,
    avg_decision_hours: round1(row?.avg_hours ?? null),
  };
}

async function getJob(ctx: Ctx, jobId: string) {
  const { job, company } = await loadJob(ctx.db, jobId);
  const mine = await myApplications(ctx, [job.id]);
  return {
    ...jobToApi(job, company),
    recruiter: await recruiterActivity(ctx.db, company),
    ...(ctx.auth.role === "candidate" ? { my_application: mine.get(job.id) ?? null } : {}),
  };
}

export function checkSalaryPair(input: JobFilters): void {
  if ((input.salary_min == null) !== (input.salary_unit == null)) {
    throw invalid([{ field: "salary_unit", message: "salary_min 和 salary_unit 必须一起传。" }]);
  }
}

/** 把搜索条件拼进 where。表别名：jobs 是 j，companies 是 c。 */
export function addJobFilters(where: Where, input: JobFilters): void {
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
    where.params.push(normCity(input.city));
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
    // 非实习岗位没填每周天数，按 5 天算
    where.clauses.push("COALESCE(j.days_per_week, 5) <= ?");
    where.params.push(input.days_per_week_max);
  }
  if (input.min_months_max !== undefined) {
    where.clauses.push("(j.min_months IS NULL OR j.min_months <= ?)");
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
  if (input.active_within_days !== undefined) {
    where.clauses.push("c.active_at >= ?");
    where.params.push(new Date(Date.now() - input.active_within_days * 86400000).toISOString());
  }
  addKeyword(where, input.q, { fts: "jobs_fts", ftsKey: "job_id", idCol: "j.id", textCol: "j.search_text" });
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
      "招聘者创建自己的公司，或修改已有公司的资料。发布岗位之前必须先有公司。只改传入的字段。公司不能重名。所有公司都显示为“未认证”。",
    method: "PUT",
    path: "/company",
    scopes: ["recruiter:write"],
    readOnly: false,
    idempotent: true,
    input: CompanyInput,
    handler: async (ctx, input) => {
      const now = nowIso();
      const existing = await primaryCompany(ctx.db, ctx.auth.accountId);
      const nameTaken = invalid([{ field: "name", message: "已经有公司叫这个名字，换一个。" }]);
      const key = input.name ? nameKey(input.name) : null;
      if (key) {
        const taken = await ctx.db
          .prepare("SELECT 1 FROM companies WHERE name_key = ? AND id <> ?")
          .bind(key, existing?.id ?? "")
          .first();
        if (taken) throw nameTaken;
      }
      // 唯一索引兜住并发时的重名
      const run = async (stmts: D1PreparedStatement[]) => {
        try {
          return await ctx.db.batch(stmts);
        } catch (err) {
          if (String(err).includes("UNIQUE")) throw nameTaken;
          throw err;
        }
      };
      if (!existing) {
        if (!input.name) throw invalid([{ field: "name", message: "第一次创建公司时必须填名称。" }]);
        const id = newId("com");
        // 并发的两次创建只有一次生效，另一次直接返回已有的公司
        await run([
          ctx.db
            .prepare(
              `INSERT INTO companies (id, owner_account_id, name, name_key, industry, scale, stage, website, intro,
                 contact_email, created_at, updated_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11
               WHERE NOT EXISTS (SELECT 1 FROM companies WHERE owner_account_id = ?2)`,
            )
            .bind(
              id,
              ctx.auth.accountId,
              input.name,
              key,
              input.industry ?? null,
              input.scale ?? null,
              input.stage ?? null,
              input.website ?? null,
              input.intro ?? null,
              input.contact_email ?? null,
              now,
            ),
        ]);
      } else {
        const pick = <K extends keyof typeof input>(key: K, current: string | null) =>
          input[key] === undefined ? current : (input[key] as string | null);
        const name = input.name ?? existing.name;
        const stmts = [
          ctx.db
            .prepare(
              `UPDATE companies SET name = ?, name_key = ?, industry = ?, scale = ?, stage = ?, website = ?, intro = ?,
                 contact_email = ?, updated_at = ? WHERE id = ?`,
            )
            .bind(
              name,
              nameKey(name),
              pick("industry", existing.industry),
              pick("scale", existing.scale),
              pick("stage", existing.stage),
              pick("website", existing.website),
              pick("intro", existing.intro),
              pick("contact_email", existing.contact_email),
              now,
              existing.id,
            ),
        ];
        if (name !== existing.name) {
          // 岗位的搜索文本里有公司名，改名后要跟着重算，不然按新名字搜不到
          const { results: jobs } = await ctx.db
            .prepare("SELECT * FROM jobs WHERE company_id = ?")
            .bind(existing.id)
            .all<JobRow>();
          for (const job of jobs) {
            const text = jobSearchText(jobFieldsFromRow(job), name);
            stmts.push(
              ctx.db.prepare("UPDATE jobs SET search_text = ? WHERE id = ?").bind(text, job.id),
              ctx.db.prepare("DELETE FROM jobs_fts WHERE job_id = ?").bind(job.id),
              ctx.db.prepare("INSERT INTO jobs_fts (job_id, body) VALUES (?, ?)").bind(job.id, text),
            );
          }
        }
        // 每个岗位占 3 条语句。岗位多时分批提交，按 3 的倍数切
        await run(stmts.slice(0, 1 + 60));
        for (let i = 61; i < stmts.length; i += 60) await run(stmts.slice(i, i + 60));
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
      checkDeadline(fields.deadline);
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
      await ctx.db.batch(jobWriteStatements(ctx.db, id, company, fields, "open", now, now, now));
      return { job: await getJob(ctx, id) };
    },
  }),

  defineOp({
    name: "job_update",
    title: "修改岗位",
    description:
      "招聘者修改自己发布的岗位。只改传入的字段，数组字段整体替换，可选字段传 null 表示清空。status 可以在 open 和 paused 之间切换。修改不会改变岗位在搜索结果里的排位。已关闭的岗位不能修改。",
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
      if (patch.deadline !== undefined) checkDeadline(patch.deadline);
      const now = nowIso();
      const next = status ?? job.status;
      // 暂停后重开算一次新的开放，订阅会把它当新岗位补发
      const openedAt = job.status === "paused" && next === "open" ? now : (job.opened_at ?? job.created_at);
      await ctx.db.batch(jobWriteStatements(ctx.db, job.id, company, merged, next, job.created_at, openedAt, now));
      return { job: await getJob(ctx, job.id) };
    },
  }),

  defineOp({
    name: "job_close",
    title: "关闭岗位",
    description:
      "招聘者关闭自己的岗位。关闭后不能再投递，也不能重新打开。这个岗位下还没约上面试的投递（已投递、已查看、已邀约）会变成“已关闭”，对应的求职者会收到事件。已接受邀约和已发录用的投递不受影响。",
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
           WHERE job_id = ? AND status IN (${placeholders(PENDING_STATUSES.length)})`,
        )
        .bind(job.id, ...PENDING_STATUSES)
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
    name: "job_stats",
    title: "查看岗位数据",
    description:
      "招聘者查看自己一个岗位的漏斗数据：详情被求职者读取的次数（不去重）、收到的投递数、查看过多少、做出决定（邀约或拒绝）的有多少、有多少走到邀约、接受、录用，各状态现在各有几条，以及拒绝原因的分布。",
    method: "GET",
    path: "/jobs/:job_id/stats",
    scopes: ["recruiter:read"],
    readOnly: true,
    input: JobGetInput,
    handler: async (ctx, input) => {
      const { job } = await loadJob(ctx.db, input.job_id, ctx.auth.accountId);
      const [totals, current, reached, reasons] = await ctx.db.batch<Record<string, number | string | null>>([
        ctx.db
          .prepare(
            `SELECT COUNT(*) AS total, COALESCE(SUM(initiated_by = 'candidate'), 0) AS by_candidate,
                    COUNT(CASE WHEN initiated_by = 'candidate' THEN decided_at END) AS decided,
                    AVG((julianday(decided_at) - julianday(created_at)) * 24) AS avg_hours
             FROM applications WHERE job_id = ?`,
          )
          .bind(job.id),
        ctx.db.prepare("SELECT status AS k, COUNT(*) AS n FROM applications WHERE job_id = ? GROUP BY status").bind(job.id),
        ctx.db
          .prepare(
            `SELECT l.to_status AS k, COUNT(DISTINCT l.application_id) AS n
             FROM application_logs l JOIN applications a ON a.id = l.application_id
             WHERE a.job_id = ? GROUP BY l.to_status`,
          )
          .bind(job.id),
        ctx.db
          .prepare(
            `SELECT reject_reason AS k, COUNT(*) AS n FROM applications
             WHERE job_id = ? AND reject_reason IS NOT NULL GROUP BY reject_reason`,
          )
          .bind(job.id),
      ]);
      const map = (rows: Record<string, number | string | null>[] | undefined) =>
        Object.fromEntries((rows ?? []).map((r) => [String(r.k), Number(r.n)]));
      const t = totals?.results[0] ?? {};
      const ever = map(reached?.results);
      const total = Number(t.total ?? 0);
      const byCandidate = Number(t.by_candidate ?? 0);
      return {
        job_id: job.id,
        title: job.title,
        status: job.status,
        detail_views: job.detail_views,
        applications: { total, by_candidate: byCandidate, by_recruiter: total - byCandidate },
        funnel: {
          applied: byCandidate,
          viewed: ever.viewed ?? 0,
          decided: Number(t.decided ?? 0),
          invited: ever.invited ?? 0,
          accepted: ever.accepted ?? 0,
          offered: ever.offered ?? 0,
          hired: ever.hired ?? 0,
        },
        avg_decision_hours: round1(t.avg_hours == null ? null : Number(t.avg_hours)),
        current: map(current?.results),
        reject_reasons: map(reasons?.results),
      };
    },
  }),

  defineOp({
    name: "job_get",
    title: "查看岗位详情",
    description:
      "查看一个岗位的全部信息，包括公司资料、职责、要求、薪资和筛选问题。accepting 为 false 表示现在不能投递（暂停、关闭或过了截止日期）。recruiter 字段是招聘者的活跃度：最近活跃时间、近 90 天收到的投递数、做出决定（邀约或拒绝）的比例和平均用时。求职者还会看到 my_application：自己对这个岗位最近一条投递的编号和状态。搜索结果只有摘要，判断是否合适前先读详情。",
    method: "GET",
    path: "/jobs/:job_id",
    scopes: ["candidate:read", "recruiter:read"],
    readOnly: true,
    input: JobGetInput,
    handler: async (ctx, input) => {
      const job = await getJob(ctx, input.job_id);
      // 求职者读一次算一次，招聘者读的不算
      if (ctx.auth.role === "candidate") {
        await ctx.db.prepare("UPDATE jobs SET detail_views = detail_views + 1 WHERE id = ?").bind(job.id).run();
      }
      return { job };
    },
  }),

  defineOp({
    name: "jobs_search",
    title: "搜索岗位",
    description:
      "按条件搜索开放中、没过截止日期的岗位，返回摘要列表，按发布时间从新到旧排列。服务端只做条件过滤，不打分；合不合适要读详情后自己判断。先用城市、招聘类型、每周天数这些硬条件缩小范围，再用关键词。每条结果带 recruiter_active_at（招聘者最近活跃时间）和 question_count（筛选问题数），求职者还会看到 my_application（投过的话是投递编号和状态，不要重复投）；active_within_days 可以滤掉没人管的岗位。招聘者传 mine=true 可以列出自己名下所有状态的岗位。",
    method: "GET",
    path: "/jobs",
    scopes: ["candidate:read", "recruiter:read"],
    readOnly: true,
    input: JobsSearchInput,
    handler: async (ctx, input) => {
      checkSalaryPair(input);
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
        addOpenFilter(where);
      }
      addJobFilters(where, input);
      addCursor(where, input.cursor, "j.created_at", "j.id");

      const limit = input.limit ?? 20;
      const { results } = await ctx.db
        .prepare(
          `SELECT j.*, c.name AS company_name, c.active_at AS recruiter_active_at FROM jobs j JOIN companies c ON c.id = j.company_id
           WHERE ${where.clauses.join(" AND ")}
           ORDER BY j.created_at DESC, j.id DESC LIMIT ?`,
        )
        .bind(...where.params, limit + 1)
        .all<JobRow & { company_name: string; recruiter_active_at: string | null }>();
      const { page, next_cursor } = paginate(results, limit, (row) => [row.created_at, row.id]);
      const mine = await myApplications(ctx, page.map((row) => row.id));
      return {
        jobs: page.map((row) => ({
          ...jobSummary(row),
          ...(ctx.auth.role === "candidate" ? { my_application: mine.get(row.id) ?? null } : {}),
        })),
        next_cursor,
      };
    },
  }),
];
