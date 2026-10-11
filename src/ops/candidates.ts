import type { Ctx } from "../env";
import { HireError, invalid, notFound } from "../errors";
import { hitRate, limits } from "../quota";
import { defineOp } from "../registry";
import {
  CandidateGetInput,
  CandidatesSearchInput,
  EmptyInput,
  ProfileUpdateInput,
  ResumeUploadInput,
  VisibilityInput,
} from "../schemas";
import { addCursor, addKeyword, paginate, placeholders, type Where } from "../search";
import { DEGREE_RANK, type Degree } from "../taxonomy";
import { base64ToBytes, nowIso, parseJson, randomHex } from "../util";

export const MAX_PDF_BYTES = 5 * 1024 * 1024;

export interface CandidateRow {
  account_id: string;
  name: string | null;
  school: string | null;
  degree: string | null;
  major: string | null;
  grad_year: number | null;
  city: string | null;
  summary: string | null;
  skills: string;
  education: string;
  experience: string;
  projects: string;
  links: string;
  expectation: string;
  resume_public: number;
  phone: string | null;
  email: string | null;
  pdf_key: string | null;
  pdf_name: string | null;
  pdf_size: number | null;
  created_at: string;
  updated_at: string;
}

interface ExpectationData {
  recruit_types?: string[];
  cities?: string[];
  days_per_week?: number;
  [key: string]: unknown;
}

/** 公开简历。不含手机、邮箱和 PDF。 */
export function candidatePublic(row: CandidateRow) {
  return {
    id: row.account_id,
    name: row.name,
    school: row.school,
    degree: row.degree,
    major: row.major,
    grad_year: row.grad_year,
    city: row.city,
    summary: row.summary,
    skills: parseJson<string[]>(row.skills, []),
    education: parseJson<unknown[]>(row.education, []),
    experience: parseJson<unknown[]>(row.experience, []),
    projects: parseJson<unknown[]>(row.projects, []),
    links: parseJson<string[]>(row.links, []),
    expectation: parseJson<ExpectationData>(row.expectation, {}),
    updated_at: row.updated_at,
  };
}

export function pdfInfo(row: CandidateRow, downloadPath: string) {
  return row.pdf_key ? { filename: row.pdf_name, size: row.pdf_size, download_path: downloadPath } : null;
}

function candidateSummary(row: CandidateRow) {
  const expectation = parseJson<ExpectationData>(row.expectation, {});
  return {
    id: row.account_id,
    name: row.name,
    school: row.school,
    degree: row.degree,
    major: row.major,
    grad_year: row.grad_year,
    city: row.city,
    skills: parseJson<string[]>(row.skills, []),
    expectation,
    updated_at: row.updated_at,
  };
}

export async function loadCandidate(db: D1Database, accountId: string): Promise<CandidateRow | null> {
  return db.prepare("SELECT * FROM candidates WHERE account_id = ?").bind(accountId).first<CandidateRow>();
}

function privateProfile(row: CandidateRow) {
  return {
    ...candidatePublic(row),
    resume_public: row.resume_public === 1,
    phone: row.phone,
    email: row.email,
    pdf: pdfInfo(row, "/v1/me/resume/pdf"),
  };
}

const REQUIRED_TO_APPLY = ["name", "school", "degree", "grad_year"] as const;

export function missingForApply(row: CandidateRow | null): string[] {
  if (!row) return [...REQUIRED_TO_APPLY];
  return REQUIRED_TO_APPLY.filter((key) => row[key] == null);
}

export const candidateOps = [
  defineOp({
    name: "profile_get",
    title: "查看我的资料",
    description: "求职者查看自己的全部资料：公开简历、求职期望、手机、邮箱、PDF 信息，以及简历是否公开。还没填过资料时返回 profile: null。",
    method: "GET",
    path: "/me/profile",
    scopes: ["candidate:read"],
    readOnly: true,
    input: EmptyInput,
    handler: async (ctx) => {
      const row = await loadCandidate(ctx.db, ctx.auth.accountId);
      return { profile: row ? privateProfile(row) : null, missing_for_apply: missingForApply(row) };
    },
  }),

  defineOp({
    name: "profile_update",
    title: "修改我的资料",
    description:
      "求职者创建或修改自己的资料。只改传入的字段；skills、education、experience、projects、links 这些数组和 expectation 对象是整体替换。只写用户确认过的事实。姓名、学校、学历、毕业年份填齐后才能投递。除手机和邮箱外，其余内容对所有招聘者公开。",
    method: "PATCH",
    path: "/me/profile",
    scopes: ["candidate:write"],
    readOnly: false,
    idempotent: true,
    input: ProfileUpdateInput,
    handler: async (ctx, input) => {
      const db = ctx.db;
      const id = ctx.auth.accountId;
      const now = nowIso();
      const old = await loadCandidate(db, id);
      const json = <T>(value: T | undefined, current: string | undefined, fallback: string) =>
        value === undefined ? (current ?? fallback) : JSON.stringify(value);

      const next = {
        name: input.name ?? old?.name ?? null,
        school: input.school ?? old?.school ?? null,
        degree: input.degree ?? old?.degree ?? null,
        major: input.major ?? old?.major ?? null,
        grad_year: input.grad_year ?? old?.grad_year ?? null,
        city: input.city ?? old?.city ?? null,
        summary: input.summary ?? old?.summary ?? null,
        skills: json(input.skills && [...new Set(input.skills)], old?.skills, "[]"),
        education: json(input.education, old?.education, "[]"),
        experience: json(input.experience, old?.experience, "[]"),
        projects: json(input.projects, old?.projects, "[]"),
        links: json(input.links, old?.links, "[]"),
        expectation: json(input.expectation, old?.expectation, "{}"),
        phone: input.phone ?? old?.phone ?? null,
        email: input.email ?? old?.email ?? null,
      };
      const skills = parseJson<string[]>(next.skills, []);
      const expectation = parseJson<ExpectationData>(next.expectation, {});
      const cities = [...new Set([...(expectation.cities ?? []), ...(next.city ? [next.city] : [])])];
      const recruitTypes = [...new Set(expectation.recruit_types ?? [])];
      const blocks = (text: string, keys: string[]) =>
        parseJson<Record<string, unknown>[]>(text, [])
          .flatMap((item) => keys.map((k) => item[k]))
          .filter((v): v is string => typeof v === "string")
          .join(" ");
      const searchText = [
        next.name,
        next.school,
        next.major,
        next.city,
        next.summary,
        skills.join(" "),
        blocks(next.education, ["school", "major"]),
        blocks(next.experience, ["company", "title", "description"]),
        blocks(next.projects, ["name", "role", "description"]),
      ]
        .filter(Boolean)
        .join("\n");

      const stmts = [
        db
          .prepare(
            `INSERT INTO candidates (account_id, name, school, degree, degree_rank, major, grad_year, city, summary,
               skills, education, experience, projects, links, expectation, days_per_week, phone, email,
               search_text, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)
             ON CONFLICT (account_id) DO UPDATE SET
               name = excluded.name, school = excluded.school, degree = excluded.degree,
               degree_rank = excluded.degree_rank, major = excluded.major, grad_year = excluded.grad_year,
               city = excluded.city, summary = excluded.summary, skills = excluded.skills,
               education = excluded.education, experience = excluded.experience, projects = excluded.projects,
               links = excluded.links, expectation = excluded.expectation,
               days_per_week = excluded.days_per_week, phone = excluded.phone, email = excluded.email,
               search_text = excluded.search_text, updated_at = excluded.updated_at`,
          )
          .bind(
            id,
            next.name,
            next.school,
            next.degree,
            next.degree ? DEGREE_RANK[next.degree as Degree] : 0,
            next.major,
            next.grad_year,
            next.city,
            next.summary,
            next.skills,
            next.education,
            next.experience,
            next.projects,
            next.links,
            next.expectation,
            expectation.days_per_week ?? null,
            next.phone,
            next.email,
            searchText,
            now,
          ),
        db.prepare("DELETE FROM candidate_cities WHERE account_id = ?").bind(id),
        db.prepare("DELETE FROM candidate_skills WHERE account_id = ?").bind(id),
        db.prepare("DELETE FROM candidate_recruit_types WHERE account_id = ?").bind(id),
        db.prepare("DELETE FROM candidates_fts WHERE account_id = ?").bind(id),
        db.prepare("INSERT INTO candidates_fts (account_id, body) VALUES (?, ?)").bind(id, searchText),
      ];
      for (const city of cities) {
        stmts.push(db.prepare("INSERT INTO candidate_cities (account_id, city) VALUES (?, ?)").bind(id, city));
      }
      for (const skill of skills) {
        stmts.push(
          db.prepare("INSERT OR IGNORE INTO candidate_skills (account_id, skill) VALUES (?, ?)").bind(id, skill),
        );
      }
      for (const type of recruitTypes) {
        stmts.push(
          db.prepare("INSERT INTO candidate_recruit_types (account_id, recruit_type) VALUES (?, ?)").bind(id, type),
        );
      }
      await db.batch(stmts);
      const row = (await loadCandidate(db, id))!;
      return { profile: privateProfile(row), missing_for_apply: missingForApply(row) };
    },
  }),

  defineOp({
    name: "resume_upload",
    title: "上传简历 PDF",
    description:
      "求职者上传一份 PDF 简历原件，替换之前上传的那份。PDF 是可选的附件：招聘者平时看的是 profile_update 填的结构化简历，只有你接受邀约后，对方才能下载这份 PDF。文件不超过 5 MB。",
    method: "PUT",
    path: "/me/resume/pdf",
    scopes: ["candidate:write"],
    readOnly: false,
    idempotent: true,
    input: ResumeUploadInput,
    handler: async (ctx, input) => {
      const bytes = base64ToBytes(input.content_base64);
      if (!bytes) throw invalid([{ field: "content_base64", message: "不是合法的 base64。" }]);
      return storePdf(ctx, input.filename, bytes);
    },
  }),

  defineOp({
    name: "resume_set_visibility",
    title: "设置简历是否公开",
    description:
      "求职者设置自己是否出现在招聘者的搜索结果里。关闭后招聘者搜不到你，但你已经投递过的岗位，招聘者仍然能看你的简历。",
    method: "PUT",
    path: "/me/resume/visibility",
    scopes: ["candidate:write"],
    readOnly: false,
    idempotent: true,
    input: VisibilityInput,
    handler: async (ctx, input) => {
      const result = await ctx.db
        .prepare("UPDATE candidates SET resume_public = ?, updated_at = ? WHERE account_id = ?")
        .bind(input.public ? 1 : 0, nowIso(), ctx.auth.accountId)
        .run();
      if (!result.meta.changes) {
        throw new HireError("not_found", "你还没有填过资料。先调用 profile_update。");
      }
      return { resume_public: input.public };
    },
  }),

  defineOp({
    name: "candidates_search",
    title: "搜索求职者",
    description:
      "招聘者按条件搜索公开了简历的求职者，返回摘要列表，按更新时间从新到旧排列。服务端只做条件过滤，不打分。结果里没有手机和邮箱，联系方式要等对方接受邀约后才能看到。",
    method: "GET",
    path: "/candidates",
    scopes: ["recruiter:read"],
    readOnly: true,
    input: CandidatesSearchInput,
    handler: async (ctx, input) => {
      await hitRate(ctx.db, `search:${ctx.auth.accountId}`, limits(ctx.env).searchPerMin, "每分钟搜索次数");
      const where: Where = { clauses: ["c.resume_public = 1", "c.name IS NOT NULL"], params: [] };
      if (input.recruit_type) {
        where.clauses.push(
          "EXISTS (SELECT 1 FROM candidate_recruit_types t WHERE t.account_id = c.account_id AND t.recruit_type = ?)",
        );
        where.params.push(input.recruit_type);
      }
      if (input.city) {
        where.clauses.push("EXISTS (SELECT 1 FROM candidate_cities cc WHERE cc.account_id = c.account_id AND cc.city = ?)");
        where.params.push(input.city);
      }
      if (input.degree) {
        where.clauses.push("c.degree_rank >= ?");
        where.params.push(DEGREE_RANK[input.degree]);
      }
      if (input.grad_year !== undefined) {
        where.clauses.push("c.grad_year = ?");
        where.params.push(input.grad_year);
      }
      if (input.days_per_week_min !== undefined) {
        where.clauses.push("c.days_per_week >= ?");
        where.params.push(input.days_per_week_min);
      }
      if (input.skills?.length) {
        where.clauses.push(
          `EXISTS (SELECT 1 FROM candidate_skills s WHERE s.account_id = c.account_id AND s.skill IN (${placeholders(input.skills.length)}))`,
        );
        where.params.push(...input.skills);
      }
      addKeyword(where, input.q, {
        fts: "candidates_fts",
        ftsKey: "account_id",
        idCol: "c.account_id",
        textCol: "c.search_text",
      });
      addCursor(where, input.cursor, "c.updated_at", "c.account_id");

      const limit = input.limit ?? 20;
      const { results } = await ctx.db
        .prepare(
          `SELECT c.* FROM candidates c WHERE ${where.clauses.join(" AND ")}
           ORDER BY c.updated_at DESC, c.account_id DESC LIMIT ?`,
        )
        .bind(...where.params, limit + 1)
        .all<CandidateRow>();
      const { page, next_cursor } = paginate(results, limit, (row) => [row.updated_at, row.account_id]);
      return { candidates: page.map(candidateSummary), next_cursor };
    },
  }),

  defineOp({
    name: "candidate_get",
    title: "查看求职者简历",
    description:
      "招聘者查看一位求职者的公开简历全文。不含手机、邮箱和 PDF；这些要等对方接受邀约后，通过 application_get 查看。",
    method: "GET",
    path: "/candidates/:candidate_id",
    scopes: ["recruiter:read"],
    readOnly: true,
    input: CandidateGetInput,
    handler: async (ctx, input) => {
      const row = await loadCandidate(ctx.db, input.candidate_id);
      if (!row || row.name == null) throw notFound("求职者");
      if (row.resume_public !== 1) {
        // 关闭公开后，只有收到过他投递的招聘者还能看
        const related = await ctx.db
          .prepare(
            `SELECT 1 FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
             WHERE a.candidate_id = ? AND c.owner_account_id = ? LIMIT 1`,
          )
          .bind(row.account_id, ctx.auth.accountId)
          .first();
        if (!related) throw notFound("求职者");
      }
      return { candidate: candidatePublic(row) };
    },
  }),
];

export async function storePdf(ctx: Ctx, filename: string, bytes: Uint8Array) {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw invalid([{ field: "content_base64", message: "文件超过 5 MB。" }]);
  }
  const header = new TextDecoder().decode(bytes.slice(0, 5));
  if (header !== "%PDF-") {
    throw invalid([{ field: "content_base64", message: "这不是 PDF 文件。只接受 PDF。" }]);
  }
  const id = ctx.auth.accountId;
  const old = await loadCandidate(ctx.db, id);
  const key = `resumes/${id}/${randomHex(12)}.pdf`;
  await ctx.env.FILES.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const now = nowIso();
  await ctx.db
    .prepare(
      `INSERT INTO candidates (account_id, pdf_key, pdf_name, pdf_size, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (account_id) DO UPDATE SET
         pdf_key = excluded.pdf_key, pdf_name = excluded.pdf_name, pdf_size = excluded.pdf_size,
         updated_at = excluded.updated_at`,
    )
    .bind(id, key, filename, bytes.byteLength, now)
    .run();
  if (old?.pdf_key) await ctx.env.FILES.delete(old.pdf_key);
  return { pdf: { filename, size: bytes.byteLength, download_path: "/v1/me/resume/pdf" } };
}
