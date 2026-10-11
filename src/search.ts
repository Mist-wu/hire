import { HireError } from "./errors";
import { decodeCursor, encodeCursor } from "./util";

export interface Where {
  clauses: string[];
  params: unknown[];
}

/** 关键词：3 个字符以上走 FTS5 trigram，更短的退回 LIKE。 */
export function addKeyword(where: Where, q: string | undefined, opts: { fts: string; ftsKey: string; idCol: string; textCol: string }) {
  if (!q) return;
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  if (long.length) {
    const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
    where.clauses.push(`${opts.idCol} IN (SELECT ${opts.ftsKey} FROM ${opts.fts} WHERE ${opts.fts} MATCH ?)`);
    where.params.push(match);
  }
  for (const t of short) {
    where.clauses.push(`${opts.textCol} LIKE ? ESCAPE '\\'`);
    where.params.push(`%${t.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
}

export function addCursor(where: Where, cursor: string | undefined, timeCol: string, idCol: string) {
  if (!cursor) return;
  const decoded = decodeCursor(cursor);
  if (!decoded || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") {
    throw new HireError("validation_failed", "cursor 无效，请用上一页返回的 next_cursor。", {
      fields: [{ field: "cursor", message: "无效" }],
    });
  }
  where.clauses.push(`(${timeCol} < ? OR (${timeCol} = ? AND ${idCol} < ?))`);
  where.params.push(decoded[0], decoded[0], decoded[1]);
}

export function paginate<T>(rows: T[], limit: number, key: (row: T) => [string, string]) {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next_cursor = rows.length > limit && last ? encodeCursor(key(last)) : null;
  return { page, next_cursor };
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
