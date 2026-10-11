import { describe, expect, it } from "vitest";
import { api, future, setup } from "./helpers";

describe("完整流程", () => {
  it("发岗位、投递、查看、邀约、接受、互见联系方式", async () => {
    const { hr, seeker, job, candidateId } = await setup();

    const found = await api("GET", "/jobs?city=北京&recruit_type=intern_daily&days_per_week_max=4", seeker);
    expect(found.data.jobs.map((j: any) => j.id)).toContain(job.id);

    const applied = await api("POST", "/applications", seeker, {
      job_id: job.id,
      custom_resume: { summary: "针对这个岗位改写的简介。" },
      note: "每周可到岗 4 天。",
    });
    expect(applied.status).toBe(200);
    const appId = applied.data.application.id;
    expect(applied.data.application.status).toBe("applied");

    // 招聘者收到事件，列表不改变状态
    const hrEvents = await api("GET", "/events", hr);
    expect(hrEvents.data.events.at(-1)).toMatchObject({ type: "application.created", application_id: appId });
    const list = await api("GET", `/jobs/${job.id}/applications`, hr);
    expect(list.data.applications[0].status).toBe("applied");

    // 看公开简历时拿不到联系方式
    const publicResume = await api("GET", `/candidates/${candidateId}`, hr);
    expect(publicResume.data.candidate.name).toBe("林晓");
    expect(publicResume.data.candidate.phone).toBeUndefined();
    expect(publicResume.data.candidate.email).toBeUndefined();

    // 第一次读详情变成已查看
    const viewed = await api("GET", `/applications/${appId}`, hr);
    expect(viewed.data.application.status).toBe("viewed");
    expect(viewed.data.application.custom_resume.summary).toContain("改写");
    expect(viewed.data.application.contact).toBeNull();
    const pdfEarly = await api("GET", `/applications/${appId}/resume.pdf`, hr);
    expect(pdfEarly.status).toBe(409);

    const slots = [future(3), future(4), future(5)];
    const invited = await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots, note: "线上面试 45 分钟。" });
    expect(invited.data.application.status).toBe("invited");

    const seekerEvents = await api("GET", "/events", seeker);
    expect(seekerEvents.data.events.map((e: any) => e.type)).toEqual(["application.viewed", "invitation.created"]);
    const beforeAccept = await api("GET", `/applications/${appId}`, seeker);
    expect(beforeAccept.data.application.contact).toBeNull();

    const wrongSlot = await api("POST", `/applications/${appId}/respond`, seeker, { accept: true, slot: future(9) });
    expect(wrongSlot.status).toBe(422);
    const accepted = await api("POST", `/applications/${appId}/respond`, seeker, { accept: true, slot: slots[1] });
    expect(accepted.data.application.status).toBe("accepted");
    expect(accepted.data.application.chosen_slot).toBe(slots[1]);
    expect(accepted.data.application.contact).toEqual({ company_email: "hr@example.com" });

    const final = await api("GET", `/applications/${appId}`, hr);
    expect(final.data.application.contact).toMatchObject({ phone: "13800000000", email: "linxiao@example.com" });
    expect(final.data.application.logs.map((l: any) => l.to_status)).toEqual(["applied", "viewed", "invited", "accepted"]);

    // 只取新事件
    const after = hrEvents.data.next_after;
    const later = await api("GET", `/events?after=${after}`, hr);
    expect(later.data.events.map((e: any) => e.type)).toEqual(["invitation.accepted"]);
  });

  it("招聘者主动邀约，求职者拒绝", async () => {
    const { hr, seeker, job, candidateId } = await setup();
    const search = await api("GET", "/candidates?city=北京&skills=Rust&days_per_week_min=4", hr);
    expect(search.data.candidates.map((c: any) => c.id)).toContain(candidateId);
    expect(JSON.stringify(search.data)).not.toContain("13800000000");

    const invited = await api("POST", "/invitations", hr, {
      job_id: job.id,
      candidate_id: candidateId,
      mode: "phone",
      slots: [future(2)],
    });
    expect(invited.data.application).toMatchObject({ status: "invited", initiated_by: "recruiter" });
    const appId = invited.data.application.id;

    const mine = await api("GET", "/applications?status=invited", seeker);
    expect(mine.data.applications.map((a: any) => a.id)).toContain(appId);
    const declined = await api("POST", `/applications/${appId}/respond`, seeker, { accept: false, note: "时间不合适。" });
    expect(declined.data.application).toMatchObject({ status: "rejected", closed_by: "candidate" });
  });

  it("上传 PDF，接受邀约后招聘者才能下载", async () => {
    const { hr, seeker, job } = await setup();
    const pdf = "%PDF-1.4\nfake resume";
    const upload = await api("PUT", "/me/resume/pdf", seeker, { filename: "林晓.pdf", content_base64: btoa(pdf) });
    expect(upload.data.pdf.size).toBe(pdf.length);
    const notPdf = await api("PUT", "/me/resume/pdf", seeker, { filename: "a.pdf", content_base64: btoa("hello") });
    expect(notPdf.status).toBe(422);

    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const slot = future(2);
    await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [slot] });
    await api("POST", `/applications/${appId}/respond`, seeker, { accept: true, slot });
    const detail = await api("GET", `/applications/${appId}`, hr);
    expect(detail.data.application.contact.pdf.download_path).toBe(`/v1/applications/${appId}/resume.pdf`);
  });
});
