import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { expireStale } from "../src/ops/applications";
import { BASE, CANDIDATE, RECRUITER, api, future, internJob, login, mcp, profile, setup, unique } from "./helpers";

const db = (env as any).DB as D1Database;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newSeeker() {
  const token = await login(unique("seeker"), CANDIDATE);
  const id = (await api("PATCH", "/me/profile", token, profile)).data.profile.id as string;
  return { token, id };
}

/** 走到“已发录用”。 */
async function offered(hr: string, jobId: string, offer: object = {}) {
  const seeker = await newSeeker();
  const appId = (await api("POST", "/applications", seeker.token, { job_id: jobId })).data.application.id as string;
  const slot = future(1);
  await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [slot] });
  await api("POST", `/applications/${appId}/respond`, seeker.token, { accept: true, slot });
  await api("POST", `/applications/${appId}/offer`, hr, offer);
  return { ...seeker, appId };
}

describe("事件", () => {
  it("传很大的 after 不会把游标拨坏", async () => {
    const { hr, seeker, job } = await setup();
    expect((await api("GET", "/events?after=999999999", hr)).data).toMatchObject({ events: [], next_after: 999999999 });
    await api("POST", "/applications", seeker, { job_id: job.id });
    expect((await api("GET", "/events", hr)).data.events).toHaveLength(1);
  });
});

describe("公司", () => {
  it("改名后按新名字能搜到岗位，旧名字搜不到", async () => {
    const { hr, seeker, job } = await setup();
    const oldName = job.company.name as string;
    const newName = unique("改名后的公司");
    await api("PUT", "/company", hr, { name: newName });
    const search = async (q: string) => (await api("GET", `/jobs?q=${encodeURIComponent(q)}`, seeker)).data.jobs.length;
    expect(await search(newName)).toBe(1);
    expect(await search(oldName)).toBe(0);
  });

  it("全角、大小写和空白不同的名字算重名", async () => {
    const name = unique("Acme Lab");
    const a = await login(unique("hr"), RECRUITER);
    const b = await login(unique("hr"), RECRUITER);
    expect((await api("PUT", "/company", a, { name })).status).toBe(200);
    for (const variant of [name.toUpperCase(), name.replace("Acme Lab", "AcmeLab"), name.replace("Acme", "Ａｃｍｅ")]) {
      expect((await api("PUT", "/company", b, { name: variant })).status).toBe(422);
    }
    // 自己改成变体不算重名
    expect((await api("PUT", "/company", a, { name: name.toUpperCase() })).status).toBe(200);
  });

  it("同一账号同时创建只会有一家公司", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    await Promise.all([1, 2, 3, 4].map(() => api("PUT", "/company", hr, { name: unique("并发公司") })));
    expect((await api("GET", "/company", hr)).data.other_companies).toBeUndefined();
  });
});

describe("订阅", () => {
  it("同时创建也挤不过上限；空关键词不算条件", async () => {
    const { token } = await newSeeker();
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, i) => api("POST", "/subscriptions", token, { name: `s${i}`, filters: { q: `关键词${i}` } })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect((await api("GET", "/subscriptions", token)).data.subscriptions).toHaveLength(5);

    const other = await newSeeker();
    expect((await api("POST", "/subscriptions", other.token, { name: "空", filters: { q: "" } })).status).toBe(422);
  });

  it("换个写法的相同条件认得出来", async () => {
    const { token } = await newSeeker();
    await api("POST", "/subscriptions", token, { name: "a", filters: { city: "北京", skills: ["Rust", "Go"] } });
    const dup = await api("POST", "/subscriptions", token, { name: "b", filters: { skills: ["Go", "Rust", "Go"], city: "北京市" } });
    expect(dup.status).toBe(422);
  });

  it("一次推不完时 has_more 为 true；同一个岗位只通知一次；暂停后重开会补发", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    const company = (await api("PUT", "/company", hr, { name: unique("订阅公司") })).data.company;
    const { token } = await newSeeker();
    await api("POST", "/subscriptions", token, { name: "公司", filters: { company_id: company.id } });
    await api("POST", "/subscriptions", token, { name: "公司加城市", filters: { company_id: company.id, city: "北京" } });
    await pause(5);
    for (let i = 0; i < 22; i++) await api("POST", "/jobs", hr, { ...internJob, title: `岗位 ${i}` });
    const first = await api("GET", "/events", token);
    expect(first.data).toMatchObject({ has_more: true });
    const second = await api("GET", "/events", token);
    const titles = [...first.data.events, ...second.data.events].map((e: any) => e.job_title);
    expect(titles).toHaveLength(22);
    expect(new Set(titles).size).toBe(22);
    expect(second.data.has_more).toBe(false);

    // 发布后马上暂停，期间别的岗位把订阅的进度推过去了，重开后仍然能收到
    const held = (await api("POST", "/jobs", hr, { ...internJob, title: "先暂停的岗位" })).data.job;
    await api("PATCH", `/jobs/${held.id}`, hr, { status: "paused" });
    await api("POST", "/jobs", hr, { ...internJob, title: "后发布的岗位" });
    expect((await api("GET", "/events", token)).data.events.map((e: any) => e.job_title)).toEqual(["后发布的岗位"]);
    await api("PATCH", `/jobs/${held.id}`, hr, { status: "open" });
    expect((await api("GET", "/events", token)).data.events.map((e: any) => e.job_title)).toEqual(["先暂停的岗位"]);
    // 再暂停再开，不重复通知
    await api("PATCH", `/jobs/${held.id}`, hr, { status: "paused" });
    await api("PATCH", `/jobs/${held.id}`, hr, { status: "open" });
    expect((await api("GET", "/events", token)).data.events).toHaveLength(0);
  });
});

describe("邀约和录用", () => {
  it("改时间最多 3 次；约好之后也能改", async () => {
    const { hr, seeker, job } = await setup();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const invite = (days: number) => api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [future(days)] });
    expect((await invite(1)).status).toBe(200);
    expect((await invite(2)).status).toBe(200);
    const slot = future(3);
    await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [slot] });
    await api("POST", `/applications/${appId}/respond`, seeker, { accept: true, slot });
    // 第 3 次：对已经约好的面试改时间
    const moved = await invite(4);
    expect(moved.data.application).toMatchObject({ status: "invited", chosen_slot: null });
    const fourth = await invite(5);
    expect(fourth.status).toBe(409);
    expect(fourth.data.error.code).toBe("invalid_transition");
    expect((await api("GET", "/events?after=0", seeker)).data.events.filter((e: any) => e.type === "invitation.updated")).toHaveLength(3);
  });

  it("面试时间不能约到一年以后", async () => {
    const { hr, seeker, job } = await setup();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const far = await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: ["9999-12-31T23:59:59Z"] });
    expect(far.status).toBe(422);
  });

  it("过了答复期限不能接受，可以拒绝；定时任务会结束它", async () => {
    const { hr, job } = await setup();
    const a = await offered(hr, job.id, { reply_by: future(3).slice(0, 10) });
    const b = await offered(hr, job.id, { reply_by: future(3).slice(0, 10) });
    await db.prepare("UPDATE applications SET offer = json_set(offer, '$.reply_by', '2020-01-01') WHERE id IN (?, ?)").bind(a.appId, b.appId).run();
    const late = await api("POST", `/applications/${a.appId}/offer/respond`, a.token, { accept: true });
    expect(late.status).toBe(409);
    expect(late.data.error.details.reply_by).toBe("2020-01-01");
    expect((await api("POST", `/applications/${a.appId}/offer/respond`, a.token, { accept: false })).status).toBe(200);
    expect(await expireStale(db)).toBeGreaterThanOrEqual(1);
    expect((await api("GET", `/applications/${b.appId}`, b.token)).data.application).toMatchObject({ status: "closed", closed_by: "system" });
  });

  it("招满之后，已经发出的录用不能再接受；同时接受最后一个名额只有一个成功", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    await api("PUT", "/company", hr, { name: unique("名额公司") });
    const job = (await api("POST", "/jobs", hr, { ...internJob, headcount: 1 })).data.job;
    const people = [await offered(hr, job.id), await offered(hr, job.id), await offered(hr, job.id)];
    const results = await Promise.all(people.map((p) => api("POST", `/applications/${p.appId}/offer/respond`, p.token, { accept: true })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const full = results.find((r) => r.status !== 200)!;
    expect(full.data.error.code).toBe("job_not_open");
    // 招聘者加了名额之后可以接受
    await api("PATCH", `/jobs/${job.id}`, hr, { headcount: 2 });
    const loser = people[results.findIndex((r) => r.status !== 200)]!;
    expect((await api("POST", `/applications/${loser.appId}/offer/respond`, loser.token, { accept: true })).status).toBe(200);
  });

  it("已经录用的人不能再投同一个岗位", async () => {
    const { hr, job } = await setup();
    const p = await offered(hr, job.id);
    await api("POST", `/applications/${p.appId}/offer/respond`, p.token, { accept: true });
    const again = await api("POST", "/applications", p.token, { job_id: job.id });
    expect(again.status).toBe(409);
    expect(again.data.error.code).toBe("duplicate_application");
    const invite = await api("POST", "/invitations", hr, { job_id: job.id, candidate_id: p.id, mode: "online", slots: [future(1)] });
    expect(invite.status).toBe(409);
  });
});

describe("输入", () => {
  it("控制字符、天文数字的薪资、结束早于开始的经历都被拒绝", async () => {
    const { hr, seeker, job } = await setup();
    const nul = await api("POST", "/jobs", hr, { ...internJob, title: "带\u0000空字符" });
    expect(nul.status).toBe(422);
    expect(nul.data.error.details.fields[0].field).toBe("title");
    // 换行和制表符可以
    expect((await api("POST", "/jobs", hr, { ...internJob, duties: "第一行\n第二行\t缩进" })).status).toBe(200);
    expect((await api("POST", "/jobs", hr, { ...internJob, salary_max: 9007199254740991 })).status).toBe(422);
    const period = { school: "x", start: "2025-09", end: "2020-06" };
    expect((await api("PATCH", "/me/profile", seeker, { education: [period] })).status).toBe(422);
    const custom = await api("POST", "/applications", seeker, { job_id: job.id, custom_resume: { education: [period] } });
    expect(custom.data.error.details.fields[0].field).toBe("custom_resume.education.0.end");
  });

  it("application_get 对求职者是只读工具，对招聘者不是；空的批量请求报错", async () => {
    const { hr, seeker } = await setup();
    const hint = async (token: string) =>
      (await mcp(token, "tools/list", {})).data.result.tools.find((t: any) => t.name === "application_get").annotations.readOnlyHint;
    expect(await hint(seeker)).toBe(true);
    expect(await hint(hr)).toBe(false);

    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${seeker}`, "Content-Type": "application/json" },
      body: "[]",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32600);
  });
});
