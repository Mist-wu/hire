import type { Ctx, Role } from "../env";
import { HireError, invalid, notFound } from "../errors";
import { appliedToday, hitRate, invitedToday, limits, quotaExceeded } from "../quota";
import { defineOp } from "../registry";
import {
  ApplicationActionInput,
  ApplicationCreateInput,
  ApplicationGetInput,
  ApplicationsListInput,
  EventsPollInput,
  InvitationCreateInput,
  InvitationRespondInput,
  JobApplicationsListInput,
  QuotaGetInput,
} from "../schemas";
import { addCursor, paginate, type Where } from "../search";
import { ACTIVE_STATUSES, APPLICATION_STATUSES, type ApplicationStatus } from "../taxonomy";
import { beijingDay, newId, nowIso, parseJson, randomHex } from "../util";
import { candidatePublic, loadCandidate, missingForApply, pdfInfo } from "./candidates";
import { loadJob } from "./jobs";

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

/** 判断调用者以哪个身份看这条投递。两边都不是就当作不存在。 */
function sideOf(ctx: Ctx, app: AppRow, need: "read" | "act", prefer?: Role): Role {
  const scope = (role: Role) => (need === "read" ? `${role}:read` : role === "candidate" ? "candidate:apply" : "recruiter:invite");
  const can = (role: Role) =>
    ctx.auth.scopes.has(scope(role) as never) &&
    (role === "candidate" ? app.candidate_id === ctx.auth.accountId : app.owner_account_id === ctx.auth.accountId);
  if (prefer && can(prefer)) return prefer;
  if (can("recruiter")) return "recruiter";
  if (can("candidate")) return "candidate";
  throw notFound("投递");
}

function mustOwn(ctx: Ctx, app: AppRow, role: Role): void {
  const owner = role === "candidate" ? app.candidate_id : app.owner_account_id;
  if (owner !== ctx.auth.accountId) throw notFound("投递");
}

function eventPayload(app: AppRow, to: Role, status: ApplicationStatus, note?: string) {
  return {
    job_id: app.job_id,
    job_title: app.job_title,
    counterpart: to === "candidate" ? app.company_name : (app.candidate_name ?? "求职者"),
    status,
    note: note ?? null,
  };
}

interface TransitionOpts {
  actor: Role | "system";
  note?: string;
  set?: Record<string, string | null>;
  event: { to: Role; type: string };
}

const TERMINAL: ApplicationStatus[] = ["accepted", "rejected", "withdrawn", "closed"];

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
    if (to !== "accepted") set.closed_by = opts.actor;
  }
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
        JSON.stringify(eventPayload(app, opts.event.to, to, opts.note)),
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

async function insertApplication(
  db: D1Database,
  fields: {
    jobId: string;
    candidateId: string;
    initiatedBy: Role;
    status: ApplicationStatus;
    customResume?: unknown;
    invitation?: Invitation;
    note?: string;
    event: { accountId: string; to: Role; type: string; payload: unknown };
  },
): Promise<string> {
  const id = newId("app");
  const now = nowIso();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO applications (id, job_id, candidate_id, initiated_by, status, custom_resume, invitation,
             rev, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
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
        ),
      db
        .prepare(
          `INSERT INTO application_logs (application_id, actor, from_status, to_status, note, created_at)
           VALUES (?, ?, NULL, ?, ?, ?)`,
        )
        .bind(id, fields.initiatedBy, fields.status, fields.note ?? null, now),
      db
        .prepare(
          `INSERT INTO events (account_id, audience, type, application_id, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(fields.event.accountId, fields.event.to, fields.event.type, id, JSON.stringify(fields.event.payload), now),
    ]);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw duplicate(null);
    throw err;
  }
  return id;
}

function duplicate(existing: { id: string; status: string } | null, retryAfter?: string): HireError {
  if (retryAfter) {
    return new HireError(
      "duplicate_application",
      `这个岗位上一条投递结束还不到 ${REAPPLY_DAYS} 天。retry_after 之后才能再投，现在不要重试。`,
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
  const base = { ...summary(app), closed_by: app.closed_by, ended_at: app.ended_at, viewing_as: side, logs };
  const accepted = app.status === "accepted";
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
      "求职者向一个岗位投递。可以附一份针对这个岗位改写的 custom_resume 和一段备注。投递会被对方看到，发出前先让用户确认内容。同一个岗位不能重复投；被拒绝或撤回后 7 天内不能再投。每天最多投 20 次。",
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
      if (job.status !== "open") {
        throw new HireError("job_not_open", "这个岗位现在不接受投递。", { current_status: job.status });
      }
      const last = await latestBetween(ctx.db, job.id, me);
      if (last) {
        if (ACTIVE_STATUSES.includes(last.status)) throw duplicate(last);
        const retryAt = new Date(new Date(last.ended_at ?? 0).getTime() + REAPPLY_DAYS * 86400000);
        if (retryAt.getTime() > Date.now()) throw duplicate(last, retryAt.toISOString());
      }
      const limit = limits(ctx.env).applyPerDay;
      if ((await appliedToday(ctx.db, me)) >= limit) throw quotaExceeded("今天的投递次数", limit, beijingDay().end);

      const id = await insertApplication(ctx.db, {
        jobId: job.id,
        candidateId: me,
        initiatedBy: "candidate",
        status: "applied",
        customResume: input.custom_resume,
        note: input.note,
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
      "查看一条投递的全部信息：状态、邀约内容、每一步的备注记录。招聘者还能看到求职者的简历和这次投递附带的 custom_resume；招聘者第一次查看时，投递会从“已投递”变成“已查看”，求职者会收到通知。状态变成“已接受”后，contact 字段里才有对方的联系方式。",
    method: "GET",
    path: "/applications/:application_id",
    scopes: ["candidate:read", "recruiter:read"],
    readOnly: false,
    idempotent: true,
    input: ApplicationGetInput,
    handler: async (ctx, input) => {
      let app = await loadApp(ctx.db, input.application_id);
      const side = sideOf(ctx, app, "read", input.as);
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
    description: "求职者撤回一条还没结束的投递，或放弃一条还没回应的邀约。撤回后不能恢复，7 天内也不能再投同一个岗位。",
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
      "招聘者发出面试邀约。两种用法：传 application_id 是回应一条已有的投递；传 job_id 加 candidate_id 是主动邀约一位还没投递的求职者，会新建一条投递。邀约里要给出面试方式和 1 到 5 个可选时间。主动邀约每个岗位每天最多 20 次。",
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
      const invitation: Invitation = {
        mode: input.mode,
        slots: checkSlots(input.slots),
        location: input.location ?? null,
      };

      if (input.application_id) {
        const app = await loadApp(ctx.db, input.application_id);
        mustOwn(ctx, app, "recruiter");
        await transition(ctx.db, app, ["applied", "viewed"], "invited", {
          actor: "recruiter",
          note: input.note,
          set: { invitation: JSON.stringify(invitation) },
          event: { to: "candidate", type: "invitation.created" },
        });
        return { application: await detail(ctx, await loadApp(ctx.db, app.id), "recruiter") };
      }

      const { job, company } = await loadJob(ctx.db, input.job_id!, ctx.auth.accountId);
      if (job.status !== "open") {
        throw new HireError("job_not_open", "这个岗位没有开放，不能发邀约。", { current_status: job.status });
      }
      const candidate = await loadCandidate(ctx.db, input.candidate_id!);
      if (!candidate || candidate.name == null || candidate.resume_public !== 1) throw notFound("求职者");
      const last = await latestBetween(ctx.db, job.id, candidate.account_id);
      if (last && ACTIVE_STATUSES.includes(last.status)) throw duplicate(last);
      const limit = limits(ctx.env).invitePerJobPerDay;
      if ((await invitedToday(ctx.db, job.id)) >= limit) {
        throw quotaExceeded("这个岗位今天的主动邀约次数", limit, beijingDay().end);
      }
      const id = await insertApplication(ctx.db, {
        jobId: job.id,
        candidateId: candidate.account_id,
        initiatedBy: "recruiter",
        status: "invited",
        invitation,
        note: input.note,
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
    description: "招聘者拒绝一条投递，或取消一条对方还没回应的邀约。拒绝后不能恢复，求职者会收到通知。",
    method: "POST",
    path: "/applications/:application_id/reject",
    scopes: ["recruiter:invite"],
    readOnly: false,
    destructive: true,
    input: ApplicationActionInput,
    handler: async (ctx, input) => {
      const app = await loadApp(ctx.db, input.application_id);
      mustOwn(ctx, app, "recruiter");
      await transition(ctx.db, app, ACTIVE_STATUSES, "rejected", {
        actor: "recruiter",
        note: input.note,
        event: { to: "candidate", type: "application.rejected" },
      });
      return { application: await detail(ctx, await loadApp(ctx.db, app.id), "recruiter") };
    },
  }),

  defineOp({
    name: "events_poll",
    title: "拉取新事件",
    description:
      "拉取发给你的新事件：新投递、被查看、收到邀约、邀约被接受、被拒绝、被撤回、岗位关闭。传 after（上次返回的 next_after）只取之后的事件。事件里只有摘要，详情用 application_get 取。有未结束的投递时每 10 分钟拉一次就够，每分钟最多 6 次。",
    method: "GET",
    path: "/events",
    scopes: [],
    readOnly: true,
    input: EventsPollInput,
    handler: async (ctx, input) => {
      await hitRate(ctx.db, `poll:${ctx.auth.accountId}`, limits(ctx.env).pollPerMin, "每分钟拉取事件的次数");
      const audiences = (["candidate", "recruiter"] as Role[]).filter((role) =>
        [...ctx.auth.scopes].some((s) => s.startsWith(`${role}:`)),
      );
      if (!audiences.length) return { events: [], next_after: input.after ?? 0, has_more: false };
      const limit = input.limit ?? 50;
      const { results } = await ctx.db
        .prepare(
          `SELECT seq, audience, type, application_id, payload, created_at FROM events
           WHERE account_id = ? AND seq > ? AND audience IN (${audiences.map(() => "?").join(", ")})
           ORDER BY seq LIMIT ?`,
        )
        .bind(ctx.auth.accountId, input.after ?? 0, ...audiences, limit + 1)
        .all<{ seq: number; audience: string; type: string; application_id: string; payload: string; created_at: string }>();
      const page = results.slice(0, limit);
      return {
        events: page.map((e) => ({
          seq: e.seq,
          type: e.type,
          audience: e.audience,
          application_id: e.application_id,
          ...parseJson<Record<string, unknown>>(e.payload, {}),
          created_at: e.created_at,
        })),
        next_after: page[page.length - 1]?.seq ?? input.after ?? 0,
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
      if (ctx.auth.scopes.has("candidate:apply") || ctx.auth.scopes.has("candidate:read")) {
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
  if (app.status !== "accepted") {
    throw new HireError("invalid_transition", "只有对方接受邀约之后，才能下载 PDF 简历。", {
      current_status: app.status,
    });
  }
  const candidate = await loadCandidate(ctx.db, app.candidate_id);
  if (!candidate?.pdf_key) throw notFound("PDF 简历");
  return { key: candidate.pdf_key, filename: candidate.pdf_name ?? "resume.pdf" };
}
