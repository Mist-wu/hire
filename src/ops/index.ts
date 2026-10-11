import { hasRole, type Auth, type Ctx, type Role } from "../env";
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
  "resume_set_visibility",
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

/** /mcp/candidate 和 /mcp/recruiter 只列出对应身份的工具。 */
export function opsFor(auth: Auth, role?: Role): Op[] {
  return OPS.filter((op) => {
    if (!allowed(op, auth)) return false;
    if (!role || op.scopes.length === 0) return true;
    return op.scopes.some((s) => s.startsWith(`${role}:`) && auth.scopes.has(s));
  });
}

const ACTIVE_STEP_MS = 3600 * 1000;

/**
 * 记下这个账号以哪个身份活跃过。只认身份明确的调用：单一身份的工具算那个身份，
 * 不限身份的（拉事件、查限额）算令牌带的全部身份。一小时内只写一次。
 */
export async function touchActive(ctx: Ctx, op: Op): Promise<void> {
  const roles = (["candidate", "recruiter"] as Role[]).filter(
    (role) => hasRole(ctx.auth, role) && op.scopes.every((s) => s.startsWith(`${role}:`)),
  );
  if (!roles.length) return;
  const now = new Date();
  const stale = new Date(now.getTime() - ACTIVE_STEP_MS).toISOString();
  const sql = {
    candidate: "UPDATE candidates SET active_at = ? WHERE account_id = ? AND (active_at IS NULL OR active_at < ?)",
    recruiter: "UPDATE companies SET active_at = ? WHERE owner_account_id = ? AND (active_at IS NULL OR active_at < ?)",
  };
  await ctx.db.batch(roles.map((role) => ctx.db.prepare(sql[role]).bind(now.toISOString(), ctx.auth.accountId, stale)));
}
