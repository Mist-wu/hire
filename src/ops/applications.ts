import type { Ctx, Role } from "../env";
import { HireError, invalid, notFound } from "../errors";
import { appliedToday, hitRate, invitedToday, limits, quotaExceeded } from "../quota";
import { defineOp } from "../registry";
import {
  ApplicationActionInput,
  ApplicationCreateInput,
  ApplicationRejectInput,
  ApplicationGetInput,
  ApplicationsListInput,
  EventsPollInput,
  InvitationCreateInput,
  InvitationRespondInput,
  JobApplicationsListInput,
  OfferCreateInput,
  OfferRespondInput,
  QuotaGetInput,
} from "../schemas";
import { addCursor, paginate, type Where } from "../search";
import {
  ACTIVE_STATUSES,
  APPLICATION_STATUSES,
  CONTACT_STATUSES,
    type ApplicationStatus,
} from "../taxonomy";
import { beijingDate, beijingDay, newId, nowIso, parseJson, randomHex } from "../util";
import { candidatePublic, loadCandidate, missingForApply, pdfInfo } from "./candidates";
import { acceptsApplications, loadJob } from "./jobs";
import { deliverMatches } from "./subscriptions";

const REAPPLY_DAYS = 7;

interface AppRow {
  id: string;
  job_id: string;
  candidate_id: string;
  initiated_by: Role;
  status: ApplicationStatus;
  custom_resume: string | null;
  invitation: string | null;
  chosen_slot: string | null;
  answers: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  offer: string | null;
  closed_by: string | null;
  ended_at: string | null;
  rev: string;
  created_at: string;
  updated_at: string;
  job_title: string;
  job_status: string;
  company_id: string;
  company_name: string;
  company_contact_email: string | null;
  owner_account_id: string;
  candidate_name: string | null;
}

interface Invitation {
  mode: string;
  slots: string[];
  location: string | null;
}

interface Answer {
  question: string;
  answer: string;
}

interface Question {
  text: string;
  options?: string[];
}

/** 对照岗位的筛选问题检查回答，返回连同题目一起存下来的快照。 */
function checkAnswers(questions: Question[], answers: string[] | undefined): Answer[] {
  if (!questions.length) {
    if (answers?.length) throw invalid([{ field: "answers", message: "这个岗位没有筛选问题，不要传 answers。" }]);
    return [];
  }
  const issues: { field: string; message: string }[] = [];
  if (!answers || answers.length !== questions.length) {
    issues.push({ field: "answers", message: `这个岗位有 ${questions.length} 个筛选问题，answers 要按顺序逐个回答。` });
  } else {
    questions.forEach((q, i) => {
      if (q.options && !q.options.includes(answers[i]!)) {
        issues.push({ field: `answers.${i}`, message: `这是单选题，只能填：${q.options.join("、")}` });
      }
    });
  }
  if (issues.length) {
    throw new HireError("validation_failed", "筛选问题没有答完整。把 details.questions 里的问题问清楚用户后再投递。", {
      fields: issues,
      questions,
    });
  }
  return questions.map((q, i) => ({ question: q.text, answer: answers![i]! }));
}

const APP_SELECT = `
  SELECT a.*, j.title AS job_title, j.status AS job_status, c.id AS company_id, c.name AS company_name,
         c.contact_email AS company_contact_email, c.owner_account_id, cand.name AS candidate_name
  FROM applications a
  JOIN jobs j ON j.id = a.job_id
  JOIN companies c ON c.id = j.company_id
  LEFT JOIN candidates cand ON cand.account_id = a.candidate_id`;

async function loadApp(db: D1Database, id: string): Promise<AppRow> {
  const row = await db.prepare(`${APP_SELECT} WHERE a.id = ?`).bind(id).first<AppRow>();
  if (!row) throw notFound("投递");
  return row;
}

/** 调用者是这条投递的哪一方。两边都不是就当作不存在。 */
function sideOf(ctx: Ctx, app: AppRow): Role {
  const role = ctx.auth.role;
  const owner = role === "candidate" ? app.candidate_id : app.owner_account_id;
  if (!role || owner !== ctx.auth.accountId) throw notFound("投递");
  return role;
}

function mustOwn(ctx: Ctx, app: AppRow, role: Role): void {
  const owner = role === "candidate" ? app.candidate_id : app.owner_account_id;
  if (owner !== ctx.auth.accountId) throw notFound("投递");
}

function eventPayload(app: AppRow, to: Role, status: ApplicationStatus, note?: string, reason?: string | null) {
  return {
    job_id: app.job_id,
    job_title: app.job_title,
    counterpart: to === "candidate" ? app.company_name : (app.candidate_name ?? "求职者"),
    status,
    note: note ?? null,
    ...(reason ? { reason } : {}),
  };
}

interface TransitionOpts {
  actor: Role | "system";
  note?: string;
  set?: Record<string, string | null>;
  event: { to: Role; type: string };
}

const TERMINAL: ApplicationStatus[] = ["hired", "rejected", "withdrawn", "closed"];

/**
 * 改状态、记日志、发事件，三件事在一个 batch 里。
 * 用 rev 做乐观锁：读出来之后被别人改过，就整体不生效。
 */
async function transition(
  db: D1Database,
  app: AppRow,
  allowedFrom: ApplicationStatus[],
  to: ApplicationStatus,
  opts: TransitionOpts,
): Promise<void> {
  if (!allowedFrom.includes(app.status)) {
    throw new HireError(
      "invalid_transition",
      `这条投递现在是“${APPLICATION_STATUSES[app.status]}”，不能改成“${APPLICATION_STATUSES[to]}”。`,
      { current_status: app.status, allowed_from: allowedFrom },
    );
  }
  const now = nowIso();
  const rev = randomHex(8);
  const set: Record<string, string | null> = { ...opts.set };
  if (TERMINAL.includes(to)) {
    set.ended_at = now;
    if (to !== "hired") set.closed_by = opts.actor;
  }
  // 招聘者第一次对求职者的投递做出决定（邀约或拒绝），记下时间。只是查看不算
  const decision = to === "invited" || to === "rejected";
  if (opts.actor === "recruiter" && decision && app.initiated_by === "candidate" && !app.decided_at) set.decided_at = now;
  const cols = Object.keys(set);
  const recipient = opts.event.to === "candidate" ? app.candidate_id : app.owner_account_id;
  const guard = "WHERE EXISTS (SELECT 1 FROM applications WHERE id = ? AND rev = ?)";

  const results = await db.batch([
    db
      .prepare(
        `UPDATE applications SET status = ?, rev = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")}
         WHERE id = ? AND rev = ?`,
      )
      .bind(to, rev, now, ...cols.map((c) => set[c] ?? null), app.id, app.rev),
    db
      .prepare(
        `INSERT INTO application_logs (application_id, actor, from_status, to_status, note, created_at)
         SELECT ?, ?, ?, ?, ?, ? ${guard}`,
      )
      .bind(app.id, opts.actor, app.status, to, opts.note ?? null, now, app.id, rev),
    db
      .prepare(
        `INSERT INTO events (account_id, audience, type, application_id, payload, created_at)
         SELECT ?, ?, ?, ?, ?, ? ${guard}`,
      )
      .bind(
        recipient,
        opts.event.to,
        opts.event.type,
        app.id,
        JSON.stringify(eventPayload(app, opts.event.to, to, opts.note, set.reject_reason)),
        now,
        app.id,
        rev,
      ),
  ]);
  if (!results[0]?.meta.changes) {
    const fresh = await loadApp(db, app.id);
    throw new HireError("invalid_transition", "这条投递刚刚被改动过。重新读取后再决定下一步。", {
      current_status: fresh.status,
    });
  }
}

/**
 * 新建投递。限额写在插入语句的条件里：先数再插分两步的话，并发请求能一起挤过上限。
 */
async function insertApplication(
  db: D1Database,
  fields: {
    jobId: string;
    candidateId: string;
    initiatedBy: Role;
    status: ApplicationStatus;
    customResume?: unknown;
    answers?: Answer[];
    invitation?: Invitation;
    note?: string;
    quota: { limit: number; what: string };
    event: { accountId: string; to: Role; type: string; payload: unknown };
  },
): Promise<string> {
  const id = newId("app");
  const now = nowIso();
  const day = beijingDay();
  // 求职者的限额按人算，招聘者主动邀约的限额按岗位算
  const scope = fields.initiatedBy === "candidate" ? "candidate_id" : "job_id";
  const scopeValue = fields.initiatedBy === "candidate" ? fields.candidateId : fields.jobId;
  const created = "WHERE EXISTS (SELECT 1 FROM applications WHERE id = ?)";
  let results;
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO applications (id, job_id, candidate_id, initiated_by, status, custom_resume, invitation,
             rev, created_at, updated_at, answers)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10
           WHERE (SELECT COUNT(*) FROM applications
                  WHERE ${scope} = ?11 AND initiated_by = ?4 AND created_at >= ?12) < ?13`,
        )
        .bind(
          id,
          fields.jobId,
          fields.candidateId,
          fields.initiatedBy,
          fields.status,
          fields.customResume ? JSON.stringify(fields.customResume) : null,
          fields.invitation ? JSON.stringify(fields.invitation) : null,
          randomHex(8),
          now,
          fields.answers?.length ? JSON.stringify(fields.answers) : null,
          scopeValue,
          day.start,
          fields.quota.limit,
        ),
      db
        .prepare(
          `INSERT INTO application_logs (application_id, actor, from_status, to_status, note, created_at)
           SELECT ?, ?, NULL, ?, ?, ? ${created}`,
        )
        .bind(id, fields.initiatedBy, fields.status, fields.note ?? null, now, id),
      db
        .prepare(
          `INSERT INTO events (account_id, audience, type, application_id, payload, created_at)
           SELECT ?, ?, ?, ?, ?, ? ${created}`,
        )
        .bind(fields.event.accountId, fields.event.to, fields.event.type, id, JSON.stringify(fields.event.payload), now, id),
    ]);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw duplicate(null);
    throw err;
  }
  if (!results[0]?.meta.changes) throw quotaExceeded(fields.quota.what, fields.quota.limit, day.end);
  return id;
}

function duplicate(existing: { id: string; status: string } | null, retryAfter?: string): HireError {
  if (retryAfter) {
    return new HireError(
      "duplicate_application",
      `这个岗位和这位求职者之间，上一条投递被拒绝或撤回还不到 ${REAPPLY_DAYS} 天。retry_after 之后才能再发起，现在不要重试。`,
      { application_id: existing?.id, status: existing?.status, retry_after: retryAfter },
    );
  }
  return new HireError("duplicate_application", "这个岗位已经有一条还没结束的投递，不能重复投。", {
    application_id: existing?.id,
    status: existing?.status,
  });
}

async function latestBetween(db: D1Database, jobId: string, candidateId: string) {
  return db
    .prepare(
      `SELECT id, status, ended_at FROM applications WHERE job_id = ? AND candidate_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(jobId, candidateId)
    .first<{ id: string; status: ApplicationStatus; ended_at: string | null }>();
}

/** 同一对岗位和求职者：有未结束的投递不能再建；被拒绝或撤回后 7 天内，任何一方都不能再发起。 */
function checkRepeat(last: { id: string; status: ApplicationStatus; ended_at: string | null } | null): void {
  if (!last) return;
  if (ACTIVE_STATUSES.includes(last.status)) throw duplicate(last);
  if (last.status !== "rejected" && last.status !== "withdrawn") return;
  const retryAt = new Date(new Date(last.ended_at ?? 0).getTime() + REAPPLY_DAYS * 86400000);
  if (retryAt.getTime() > Date.now()) throw duplicate(last, retryAt.toISOString());
}

function checkSlots(slots: string[]): string[] {
  const now = Date.now();
  const normalized = slots.map((s) => new Date(s));
  if (normalized.some((d) => d.getTime() <= now)) {
    throw invalid([{ field: "slots", message: "面试时间必须在将来。" }]);
  }
  return [...new Set(normalized.map((d) => d.toISOString()))];
}

function summary(app: AppRow) {
  return {
    id: app.id,
    status: app.status,
    initiated_by: app.initiated_by,
    job_id: app.job_id,
    job_title: app.job_title,
    company_name: app.company_name,
    candidate_id: app.candidate_id,
    candidate_name: app.candidate_name,
    invitation: parseJson<Invitation | null>(app.invitation, null),
    chosen_slot: app.chosen_slot,
    offer: parseJson<unknown>(app.offer, null),
    reject_reason: app.reject_reason,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}

async function detail(ctx: Ctx, app: AppRow, side: Role) {
  const { results: logs } = await ctx.db
    .prepare(
      "SELECT actor, from_status, to_status, note, created_at FROM application_logs WHERE application_id = ? ORDER BY id",
    )
    .bind(app.id)
    .all();
  const base = {
    ...summary(app),
    answers: parseJson<Answer[]>(app.answers, []),
    closed_by: app.closed_by,
    ended_at: app.ended_at,
    viewing_as: side,
    logs,
  };
  const accepted = CONTACT_STATUSES.includes(app.status);
  if (side === "candidate") {
    return {
      ...base,
      custom_resume: parseJson<unknown>(app.custom_resume, null),
      contact: accepted ? { company_email: app.company_contact_email } : null,
    };
  }
  const candidate = await loadCandidate(ctx.db, app.candidate_id);
  return {
    ...base,
    candidate: candidate ? candidatePublic(candidate) : null,
    custom_resume: parseJson<unknown>(app.custom_resume, null),
    contact:
      accepted && candidate
        ? {
            phone: candidate.phone,
            email: candidate.email,
            pdf: pdfInfo(candidate, `/v1/applications/${app.id}/resume.pdf`),
          }
        : null,
  };
}

async function listApps(ctx: Ctx, where: Where, input: { cursor?: string; limit?: number }) {
  addCursor(where, input.cursor, "a.updated_at", "a.id");
  const limit = input.limit ?? 20;
  const { results } = await ctx.db
    .prepare(`${APP_SELECT} WHERE ${where.clauses.join(" AND ")} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`)
    .bind(...where.params, limit + 1)
    .all<AppRow>();
  const { page, next_cursor } = paginate(results, limit, (row) => [row.updated_at, row.id]);
  return { applications: page.map(summary), next_cursor };
}

export const applicationOps = [
  defineOp({
    name: "application_create",
    title: "投递岗位",
    description:
      "求职者向一个岗位投递。可以附一份针对这个岗位改写的 custom_resume 和一段备注。岗位有筛选问题（job_get 返回的 questions）时，必须在 answers 里按顺序逐个回答，答案要来自用户，不要自己编。投递会被对方看到，发出前先让用户确认内容。同一个岗位不能重复投；被拒绝或撤回后 7 天内不能再投。岗位暂停、关闭或过了截止日期时不能投。每天最多投 20 次。",
    method: "POST",
    path: "/applications",
    scopes: ["candidate:apply"],
    readOnly: false,
    input: ApplicationCreateInput,
    handler: async (ctx, input) => {
      const me = ctx.auth.accountId;
      const candidate = await loadCandidate(ctx.db, me);
      const missing = missingForApply(candidate);
      if (missing.length) {
        throw invalid(
          missing.map((field) => ({ field, message: "资料里缺这一项。" })),
          "资料不完整，还不能投递。先用 profile_update 补齐姓名、学校、学历和毕业年份。",
        );
      }
      const { job, company } = await loadJob(ctx.db, input.job_id);
      if (!acceptsApplications(job)) {
        throw new HireError("job_not_open", "这个岗位现在不接受投递：已暂停、已关闭，或过了截止日期。", {
          current_status: job.status,
          deadline: job.deadline,
        });
      }
      checkRepeat(await latestBetween(ctx.db, job.id, me));
      const answers = checkAnswers(parseJson<Question[]>(job.questions, []), input.answers);

      const id = await insertApplication(ctx.db, {
        jobId: job.id,
        candidateId: me,
        initiatedBy: "candidate",
        status: "applied",
        customResume: input.custom_resume,
        answers,
        note: input.note,
        quota: { limit: limits(ctx.env).applyPerDay, what: "今天的投递次数" },
        event: {
          accountId: company.owner_account_id,
          to: "recruiter",
          type: "application.created",
          payload: {
            job_id: job.id,
            job_title: job.title,
            counterpart: candidate!.name,
            status: "applied",
            note: input.note ?? null,
          },
        },
      });
      return { application: await detail(ctx, await loadApp(ctx.db, id), "candidate") };
    },
  }),

  defineOp({
    name: "applications_list",
    title: "查看我的投递",
    description: "求职者列出自己的全部投递和收到的邀约，按更新时间从新到旧排列。可以按状态过滤。",
    method: "GET",
    path: "/applications",
    scopes: ["candidate:read"],
    readOnly: true,
    input: ApplicationsListInput,
    handler: async (ctx, input) => {
      const where: Where = { clauses: ["a.candidate_id = ?"], params: [ctx.auth.accountId] };
      if (input.status) {
        where.clauses.push("a.status = ?");
        where.params.push(input.status);
      }
      return listApps(ctx, where, input);
    },
  }),

  defineOp({
    name: "job_applications_list",
    title: "查看岗位收到的投递",
    description:
      "招聘者列出自己某个岗位下的全部投递，按更新时间从新到旧排列。这里只有摘要，不会把投递标成“已查看”。要看简历全文请调用 application_get。",
    method: "GET",
    path: "/jobs/:job_id/applications",
    scopes: ["recruiter:read"],
    readOnly: true,
    input: JobApplicationsListInput,
    handler: async (ctx, input) => {
      await loadJob(ctx.db, input.job_id, ctx.auth.accountId);
      const where: Where = { clauses: ["a.job_id = ?"], params: [input.job_id] };
      if (input.status) {
        where.clauses.push("a.status = ?");
        where.params.push(input.status);
      }
      return listApps(ctx, where, input);
    },
  }),

  defineOp({
    name: "application_get",
    title: "查看投递详情",
    description:
      "查看一条投递的全部信息：状态、邀约内容、筛选问题的回答、录用内容、每一步的备注记录。招聘者还能看到求职者的简历和这次投递附带的 custom_resume；招聘者第一次查看时，投递会从“已投递”变成“已查看”，求职者会收到通知。状态是“已接受”“已发录用”“已录用”时，contact 字段里才有对方的联系方式。",
    method: "GET",
    path: "/applications/:application_id",
    scopes: ["candidate:read", "recruiter:read"],
    readOnly: false,
    idempotent: true,
    input: ApplicationGetInput,
    handler: async (ctx, input) => {
      let app = await loadApp(ctx.db, input.application_id);
      const side = sideOf(ctx, app);
      if (side === "recruiter" && app.status === "applied") {
        try {
          await transition(ctx.db, app, ["applied"], "viewed", {
            actor: "recruiter",
            event: { to: "candidate", type: "application.viewed" },
          });
        } catch (err) {
          if (!(err instanceof HireError) || err.code !== "invalid_transition") throw err;
        }
        app = await loadApp(ctx.db, app.id);
      }
      return { application: await detail(ctx, app, side) };
    },
  }),

  defineOp({
    name: "application_withdraw",
    title: "撤回投递",
    description: "求职者撤回一条还没结束的投递：可以是还没回音的投递、还没回应的邀约，也可以是已经约好的面试。撤回后不能恢复，7 天内也不能再投同一个岗位。",
    method: "POST",
    path: "/applications/:application_id/withdraw",
    scopes: ["candidate:apply"],
    readOnly: false,
    destructive: true,
    input: ApplicationActionInput,
    handler: async (ctx, input) => {
      const app = await loadApp(ctx.db, input.application_id);
      mustOwn(ctx, app, "candidate");
      await transition(ctx.db, app, ACTIVE_STATUSES, "withdrawn", {
        actor: "candidate",
        note: input.note,
        event: { to: "recruiter", type: "application.withdrawn" },
      });
      return { application: await detail(ctx, await loadApp(ctx.db, app.id), "candidate") };
    },
  }),

  defineOp({
    name: "invitation_respond",
    title: "回应邀约",
    description:
      "求职者接受或拒绝一条面试邀约。接受时必须从邀约给出的时间里选一个填到 slot。接受后，对方能看到你的手机、邮箱和 PDF 简历，你能看到公司的联系邮箱。这一步不能撤销，回应前先让用户确认。",
    method: "POST",
    path: "/applications/:application_id/respond",
    scopes: ["candidate:apply"],
    readOnly: false,
    destructive: true,
    input: InvitationRespondInput,
    handler: async (ctx, input) => {
      const app = await loadApp(ctx.db, input.application_id);
      mustOwn(ctx, app, "candidate");
      if (!input.accept) {
        await transition(ctx.db, app, ["invited"], "rejected", {
          actor: "candidate",
          note: input.note,
          event: { to: "recruiter", type: "application.rejected" },
        });
      } else {
        const invitation = parseJson<Invitation | null>(app.invitation, null);
        const slot = input.slot ? new Date(input.slot).toISOString() : null;
        if (app.status === "invited" && (!slot || !invitation?.slots.includes(slot))) {
          throw invalid([
            {
              field: "slot",
              message: `接受时必须从邀约给出的时间里选一个：${invitation?.slots.join("、") ?? ""}`,
            },
          ]);
        }
        if (app.status === "invited" && slot && new Date(slot).getTime() <= Date.now()) {
          throw invalid([{ field: "slot", message: "这个时间已经过了，选一个还没到的。都过了就拒绝，并在备注里请对方重新约。" }]);
        }
        await transition(ctx.db, app, ["invited"], "accepted", {
          actor: "candidate",
          note: input.note,
          set: { chosen_slot: slot },
          event: { to: "recruiter", type: "invitation.accepted" },
        });
      }
      return { application: await detail(ctx, await loadApp(ctx.db, app.id), "candidate") };
    },
  }),

  defineOp({
    name: "invitation_create",
    title: "发出面试邀约",
    description:
      "招聘者发出面试邀约。两种用法：传 application_id 是回应一条已有的投递，对一条还没回应的邀约再调一次就是改时间；传 job_id 加 candidate_id 是主动邀约一位还没投递的求职者，会新建一条投递。邀约里要给出面试方式和 1 到 5 个可选时间，线下面试要写地址。主动邀约每个岗位每天最多 20 次；对方拒绝或撤回后 7 天内不能再邀约同一个人。",
    method: "POST",
    path: "/invitations",
    scopes: ["recruiter:invite"],
    readOnly: false,
    input: InvitationCreateInput,
    handler: async (ctx, input) => {
      const proactive = input.job_id !== undefined || input.candidate_id !== undefined;
      if (input.application_id ? proactive : !(input.job_id && input.candidate_id)) {
        throw invalid(
          [{ field: "application_id", message: "只传 application_id，或者同时传 job_id 和 candidate_id。" }],
          "入参二选一：回应投递传 application_id；主动邀约传 job_id 和 candidate_id。",
        );
      }
      if (input.mode === "onsite" && !input.location) {
        throw invalid([{ field: "location", message: "线下面试必须写地址。" }]);
      }
      const invitation: Invitation = {
        mode: input.mode,
        slots: checkSlots(input.slots),
        location: input.location ?? null,
      };

      if (input.application_id) {
        const app = await loadApp(ctx.db, input.application_id);
        mustOwn(ctx, app, "recruiter");
        await transition(ctx.db, app, ["applied", "viewed", "invited"], "invited", {
          actor: "recruiter",
          note: input.note,
          set: { invitation: JSON.stringify(invitation) },
          event: { to: "candidate", type: app.status === "invited" ? "invitation.updated" : "invitation.created" },
        });
        return { application: await detail(ctx, await loadApp(ctx.db, app.id), "recruiter") };
      }

      const { job, company } = await loadJob(ctx.db, input.job_id!, ctx.auth.accountId);
      if (!acceptsApplications(job)) {
        throw new HireError("job_not_open", "这个岗位没有开放或过了截止日期，不能发邀约。", {
          current_status: job.status,
          deadline: job.deadline,
        });
      }
      const candidate = await loadCandidate(ctx.db, input.candidate_id!);
      if (!candidate || candidate.name == null || candidate.resume_public !== 1) throw notFound("求职者");
      checkRepeat(await latestBetween(ctx.db, job.id, candidate.account_id));
      const id = await insertApplication(ctx.db, {
        jobId: job.id,
        candidateId: candidate.account_id,
        initiatedBy: "recruiter",
        status: "invited",
        invitation,
        note: input.note,
        quota: { limit: limits(ctx.env).invitePerJobPerDay, what: "这个岗位今天的主动邀约次数" },
        event: {
          accountId: candidate.account_id,
          to: "candidate",
          type: "invitation.created",
          payload: {
            job_id: job.id,
            job_title: job.title,
            counterpart: company.name,
            status: "invited",
            note: input.note ?? null,
          },
        },
      });
      return { application: await detail(ctx, await loadApp(ctx.db, id), "recruiter") };
    },
  }),

  defineOp({
    name: "application_reject",
    title: "拒绝投递",
    description:
      "招聘者拒绝一条还没结束的投递：可以是筛简历时不合适、取消邀约、面试没通过，或撤回录用。必须在 reason 里选一个原因，求职者能看到。拒绝后不能恢复。",
    method: "POST",
    path: "/applications/:application_id/reject",
    scopes: ["recruiter:invite"],
    readOnly: false,
    destructive: true,
    input: ApplicationRejectInput,
    handler: async (ctx, input) => {
      const app = await loadApp(ctx.db, input.application_id);
      mustOwn(ctx, app, "recruiter");
      await transition(ctx.db, app, ACTIVE_STATUSES, "rejected", {
        actor: "recruiter",
        note: input.note,
        set: { reject_reason: input.reason },
        event: { to: "candidate", type: "application.rejected" },
      });
      return { application: await detail(ctx, await loadApp(ctx.db, app.id), "recruiter") };
    },
  }),

  defineOp({
    name: "offer_create",
    title: "发出录用",
    description:
      "招聘者在面试之后向求职者发出录用。只有“已接受”邀约的投递可以发。可以写明入职日期、薪资和答复期限。面试没通过请用 application_reject，reason 选 interview_failed。发出前先让用户确认。",
    method: "POST",
    path: "/applications/:application_id/offer",
    scopes: ["recruiter:invite"],
    readOnly: false,
    input: OfferCreateInput,
    handler: async (ctx, input) => {
      if ((input.salary == null) !== (input.salary_unit == null)) {
        throw invalid([{ field: "salary_unit", message: "salary 和 salary_unit 必须一起传。" }]);
      }
      const today = beijingDate();
      const past = (["start_date", "reply_by"] as const).filter((key) => input[key] && input[key]! < today);
      if (past.length) throw invalid(past.map((field) => ({ field, message: "日期不能在过去。" })));
      const app = await loadApp(ctx.db, input.application_id);
      mustOwn(ctx, app, "recruiter");
      const offer = {
        start_date: input.start_date ?? null,
        salary: input.salary ?? null,
        salary_unit: input.salary_unit ?? null,
        reply_by: input.reply_by ?? null,
      };
      await transition(ctx.db, app, ["accepted"], "offered", {
        actor: "recruiter",
        note: input.note,
        set: { offer: JSON.stringify(offer) },
        event: { to: "candidate", type: "offer.created" },
      });
      return { application: await detail(ctx, await loadApp(ctx.db, app.id), "recruiter") };
    },
  }),

  defineOp({
    name: "offer_respond",
    title: "回应录用",
    description:
      "求职者接受或拒绝一份录用。接受后投递变成“已录用”，流程结束；拒绝后变成“已拒绝”。岗位填了招聘人数、录用人数到了的话，岗位会自动暂停。这一步不能撤销，回应前先让用户确认。",
    method: "POST",
    path: "/applications/:application_id/offer/respond",
    scopes: ["candidate:apply"],
    readOnly: false,
    destructive: true,
    input: OfferRespondInput,
    handler: async (ctx, input) => {
      const app = await loadApp(ctx.db, input.application_id);
      mustOwn(ctx, app, "candidate");
      await transition(ctx.db, app, ["offered"], input.accept ? "hired" : "rejected", {
        actor: "candidate",
        note: input.note,
        event: { to: "recruiter", type: input.accept ? "offer.accepted" : "application.rejected" },
      });
      // 录用人数到了招聘人数，岗位自动暂停，等招聘者决定是关闭还是继续招
      if (input.accept) {
        await ctx.db
          .prepare(
            `UPDATE jobs SET status = 'paused' WHERE id = ?1 AND status = 'open' AND headcount IS NOT NULL
               AND (SELECT COUNT(*) FROM applications WHERE job_id = ?1 AND status = 'hired') >= headcount`,
          )
          .bind(app.job_id)
          .run();
      }
      return { application: await detail(ctx, await loadApp(ctx.db, app.id), "candidate") };
    },
  }),

  defineOp({
    name: "events_poll",
    title: "拉取新事件",
    description:
      "拉取发给你的新事件：新投递、被查看、收到邀约、邀约改了时间、邀约被接受、收到录用、录用被接受、被拒绝、被撤回、岗位关闭、投递过期，以及订阅命中的新岗位（job.matched，没有 application_id，用 job_get 读详情）。服务端记着你上次拉到哪，直接调用就只返回新事件；has_more 为 true 时再调一次。想重看旧事件时传 after。事件里只有摘要，投递详情用 application_get 取。有未结束的投递或有订阅时每 10 分钟拉一次就够，每分钟最多 6 次。",
    method: "GET",
    path: "/events",
    scopes: [],
    readOnly: true,
    input: EventsPollInput,
    handler: async (ctx, input) => {
      await hitRate(ctx.db, `poll:${ctx.auth.accountId}`, limits(ctx.env).pollPerMin, "每分钟拉取事件的次数");
      const role = ctx.auth.role;
      if (!role || !ctx.auth.scopes.size) return { events: [], next_after: input.after ?? 0, has_more: false };
      if (role === "candidate") await deliverMatches(ctx);
      const account = await ctx.db
        .prepare("SELECT events_cursor FROM accounts WHERE id = ?")
        .bind(ctx.auth.accountId)
        .first<{ events_cursor: number }>();
      const after = input.after ?? account?.events_cursor ?? 0;
      const limit = input.limit ?? 50;
      const { results } = await ctx.db
        .prepare(
          `SELECT seq, type, application_id, payload, created_at FROM events
           WHERE account_id = ? AND seq > ? AND audience = ? ORDER BY seq LIMIT ?`,
        )
        .bind(ctx.auth.accountId, after, role, limit + 1)
        .all<{ seq: number; type: string; application_id: string | null; payload: string; created_at: string }>();
      const page = results.slice(0, limit);
      const nextAfter = page[page.length - 1]?.seq ?? after;
      // 记下拉到哪了。下次不传 after 就从这里接着拉，agent 换了会话也不会把旧事件再报一遍
      if (nextAfter > (account?.events_cursor ?? 0)) {
        await ctx.db
          .prepare("UPDATE accounts SET events_cursor = ? WHERE id = ? AND events_cursor < ?")
          .bind(nextAfter, ctx.auth.accountId, nextAfter)
          .run();
      }
      return {
        events: page.map((e) => ({
          seq: e.seq,
          type: e.type,
          application_id: e.application_id,
          ...parseJson<Record<string, unknown>>(e.payload, {}),
          created_at: e.created_at,
        })),
        next_after: nextAfter,
        has_more: results.length > limit,
      };
    },
  }),

  defineOp({
    name: "quota_get",
    title: "查看限额余量",
    description: "查看各项限额今天或这一分钟还剩多少，以及什么时候重置。",
    method: "GET",
    path: "/quota",
    scopes: [],
    readOnly: true,
    input: QuotaGetInput,
    handler: async (ctx, input) => {
      const l = limits(ctx.env);
      const day = beijingDay();
      const out: Record<string, unknown> = {
        search: { limit_per_minute: l.searchPerMin },
        events_poll: { limit_per_minute: l.pollPerMin },
      };
      if (ctx.auth.role === "candidate") {
        const used = await appliedToday(ctx.db, ctx.auth.accountId);
        out.applications = { limit: l.applyPerDay, used, remaining: Math.max(0, l.applyPerDay - used), reset_at: day.end };
      }
      if (input.job_id) {
        await loadJob(ctx.db, input.job_id, ctx.auth.accountId);
        const used = await invitedToday(ctx.db, input.job_id);
        out.proactive_invitations = {
          job_id: input.job_id,
          limit: l.invitePerJobPerDay,
          used,
          remaining: Math.max(0, l.invitePerJobPerDay - used),
          reset_at: day.end,
        };
      }
      return out;
    },
  }),
];

/** 招聘者下载求职者的 PDF。只有“已接受”的投递可以。 */
export async function resumePdfForApplication(ctx: Ctx, applicationId: string) {
  const app = await loadApp(ctx.db, applicationId);
  mustOwn(ctx, app, "recruiter");
  if (!CONTACT_STATUSES.includes(app.status)) {
    throw new HireError("invalid_transition", "只有对方接受邀约之后，才能下载 PDF 简历。", {
      current_status: app.status,
    });
  }
  const candidate = await loadCandidate(ctx.db, app.candidate_id);
  if (!candidate?.pdf_key) throw notFound("PDF 简历");
  return { key: candidate.pdf_key, filename: candidate.pdf_name ?? "resume.pdf" };
}

const EXPIRE_DAYS = 30;

/**
 * 每天清一次没人管的投递，改成“已关闭”，给双方各发一条事件：
 * 投递 30 天没等到决定；邀约给的时间全过了还没回应；约好的面试过了 30 天没有结果；录用发出 30 天没回应。
 */
export async function expireStale(db: D1Database): Promise<number> {
  const now = nowIso();
  const cutoff = new Date(Date.now() - EXPIRE_DAYS * 86400000).toISOString();
  const cases: { where: string; params: unknown[]; note: string }[] = [
    {
      where: "a.status IN ('applied', 'viewed') AND a.created_at < ?",
      params: [cutoff],
      note: `${EXPIRE_DAYS} 天没有等到决定，自动结束。`,
    },
    {
      where:
        "a.status = 'invited' AND NOT EXISTS (SELECT 1 FROM json_each(a.invitation, '$.slots') s WHERE s.value > ?)",
      params: [now],
      note: "邀约给出的时间都过了，没有回应，自动结束。",
    },
    {
      where: "a.status = 'accepted' AND a.chosen_slot < ?",
      params: [cutoff],
      note: `面试时间过去 ${EXPIRE_DAYS} 天没有结果，自动结束。`,
    },
    {
      where: "a.status = 'offered' AND a.updated_at < ?",
      params: [cutoff],
      note: `录用发出 ${EXPIRE_DAYS} 天没有回应，自动结束。`,
    },
  ];
  let closed = 0;
  for (const c of cases) {
    const from = "FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id";
    const payload = (counterpart: string) =>
      `json_object('job_id', j.id, 'job_title', j.title, 'counterpart', ${counterpart}, 'status', 'closed', 'note', ?)`;
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO application_logs (application_id, actor, from_status, to_status, note, created_at)
           SELECT a.id, 'system', a.status, 'closed', ?, ? FROM applications a WHERE ${c.where}`,
        )
        .bind(c.note, now, ...c.params),
      db
        .prepare(
          `INSERT INTO events (account_id, audience, type, application_id, payload, created_at)
           SELECT a.candidate_id, 'candidate', 'application.expired', a.id, ${payload("c.name")}, ? ${from}
           WHERE ${c.where}`,
        )
        .bind(c.note, now, ...c.params),
      db
        .prepare(
          `INSERT INTO events (account_id, audience, type, application_id, payload, created_at)
           SELECT c.owner_account_id, 'recruiter', 'application.expired', a.id,
                  ${payload("COALESCE((SELECT name FROM candidates WHERE account_id = a.candidate_id), '求职者')")}, ? ${from}
           WHERE ${c.where}`,
        )
        .bind(c.note, now, ...c.params),
      db
        .prepare(
          `UPDATE applications AS a SET status = 'closed', closed_by = 'system', ended_at = ?, updated_at = ?,
             rev = lower(hex(randomblob(8))) WHERE ${c.where}`,
        )
        .bind(now, now, ...c.params),
    ]);
    closed += results[3]?.meta.changes ?? 0;
  }
  return closed;
}
