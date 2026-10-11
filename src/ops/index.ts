import type { Auth, Role } from "../env";
import { HireError } from "../errors";
import type { Op } from "../registry";
import { applicationOps } from "./applications";
import { candidateOps } from "./candidates";
import { jobOps } from "./jobs";

const ORDER = [
  "profile_get",
  "profile_update",
  "resume_upload",
  "resume_set_visibility",
  "jobs_search",
  "job_get",
  "application_create",
  "applications_list",
  "application_withdraw",
  "invitation_respond",
  "company_get",
  "company_upsert",
  "job_create",
  "job_update",
  "job_close",
  "candidates_search",
  "candidate_get",
  "job_applications_list",
  "invitation_create",
  "application_reject",
  "application_get",
  "events_poll",
  "quota_get",
];

const all = [...candidateOps, ...jobOps, ...applicationOps];
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
