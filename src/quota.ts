import type { Env } from "./env";
import { HireError } from "./errors";
import { beijingDay } from "./util";

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function limits(env: Env) {
  return {
    applyPerDay: int(env.QUOTA_APPLY_PER_DAY, 20),
    invitePerJobPerDay: int(env.QUOTA_INVITE_PER_JOB_PER_DAY, 20),
    searchPerMin: int(env.QUOTA_SEARCH_PER_MIN, 30),
    pollPerMin: int(env.QUOTA_POLL_PER_MIN, 6),
  };
}

export function quotaExceeded(what: string, limit: number, resetAt: string): HireError {
  return new HireError("quota_exceeded", `${what}已达上限 ${limit} 次。到 reset_at 之后再试，现在不要重试。`, {
    limit,
    reset_at: resetAt,
  });
}

/** 每分钟限频：计数加一，超出就报错。 */
export async function hitRate(db: D1Database, key: string, limit: number, what: string): Promise<void> {
  const minute = Math.floor(Date.now() / 60000);
  const row = await db
    .prepare(
      `INSERT INTO rate_counters (key, bucket, count) VALUES (?, ?, 1)
       ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(key, String(minute))
    .first<{ count: number }>();
  if ((row?.count ?? 1) > limit) {
    throw quotaExceeded(what, limit, new Date((minute + 1) * 60000).toISOString());
  }
}

export async function appliedToday(db: D1Database, candidateId: string): Promise<number> {
  const { start } = beijingDay();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM applications
       WHERE candidate_id = ? AND initiated_by = 'candidate' AND created_at >= ?`,
    )
    .bind(candidateId, start)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function invitedToday(db: D1Database, jobId: string): Promise<number> {
  const { start } = beijingDay();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM applications
       WHERE job_id = ? AND initiated_by = 'recruiter' AND created_at >= ?`,
    )
    .bind(jobId, start)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
