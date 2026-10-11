import type { Auth, Ctx } from "../env";
import { HireError } from "../errors";
import type { Op } from "../registry";
import { applicationOps } from "./applications";
import { candidateOps } from "./candidates";
import { jobOps } from "./jobs";
import { subscriptionOps } from "./subscriptions";

const ORDER = [
  "profile_get",
  "profile_update",
  "resume_upload",
  "profile_delete",
  "jobs_search",
  "job_get",
  "subscription_create",
  "subscriptions_list",
  "subscription_delete",
  "application_create",
  "applications_list",
  "application_withdraw",
  "invitation_respond",
  "offer_respond",
  "company_get",
  "company_upsert",
  "job_create",
  "job_update",
  "job_close",
  "job_stats",
  "candidates_search",
  "candidate_get",
  "job_applications_list",
  "invitation_create",
  "offer_create",
  "application_reject",
  "application_get",
  "events_poll",
  "quota_get",
];

const all = [...candidateOps, ...jobOps, ...subscriptionOps, ...applicationOps];
export const OPS: Op[] = ORDER.map((name) => {
  const found = all.find((op) => op.name === name);
  if (!found) throw new Error(`missing op ${name}`);
  return found;
});

export function allowed(op: Op, auth: Auth): boolean {
  return op.scopes.length === 0 || op.scopes.some((s) => auth.scopes.has(s));
}

export function requireScope(op: Op, auth: Auth): void {
  if (!allowed(op, auth)) {
    throw new HireError(
      "forbidden_scope",
      `这个令牌没有调用 ${op.name} 的权限，需要范围 ${op.scopes.join(" 或 ")}。换一个带这个范围的令牌，不要重试。`,
      { required: op.scopes, granted: [...auth.scopes] },
    );
  }
}

/** 工具列表只列这个令牌能调的。 */
export function opsFor(auth: Auth): Op[] {
  return OPS.filter((op) => allowed(op, auth));
}

const ACTIVE_STEP_MS = 3600 * 1000;
/** 定时拉事件和查限额不算活跃，不然挂着轮询就永远“刚刚活跃”。 */
const PASSIVE_OPS = ["events_poll", "quota_get"];

/** 记下这个账号最近一次主动操作的时间。一小时内只写一次。 */
export async function touchActive(ctx: Ctx, op: Op): Promise<void> {
  if (!ctx.auth.role || PASSIVE_OPS.includes(op.name)) return;
  const now = new Date();
  const stale = new Date(now.getTime() - ACTIVE_STEP_MS).toISOString();
  const sql =
    ctx.auth.role === "candidate"
      ? "UPDATE candidates SET active_at = ? WHERE account_id = ? AND (active_at IS NULL OR active_at < ?)"
      : "UPDATE companies SET active_at = ? WHERE owner_account_id = ? AND (active_at IS NULL OR active_at < ?)";
  await ctx.db.prepare(sql).bind(now.toISOString(), ctx.auth.accountId, stale).run();
}
