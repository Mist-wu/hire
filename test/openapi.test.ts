import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { OPS } from "../src/ops";
import { applicationOps } from "../src/ops/applications";
import { candidateOps } from "../src/ops/candidates";
import { jobOps } from "../src/ops/jobs";
import { subscriptionOps } from "../src/ops/subscriptions";
import { BASE, CANDIDATE, login, mcp, unique } from "./helpers";

describe("OpenAPI", () => {
  it("多个范围有一个即可；列出 PDF 下载和上传的几种格式", async () => {
    const doc = await (await SELF.fetch(`${BASE}/v1/openapi.json`)).json<any>();
    expect(doc.info.version).toBe(pkg.version);
    expect(doc.paths["/v1/jobs/{job_id}"].get.security).toEqual([
      { bearer: ["candidate:read"] },
      { bearer: ["recruiter:read"] },
    ]);
    expect(doc.paths["/v1/events"].get.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(doc.paths["/v1/me/resume/pdf"]).sort()).toEqual(["get", "put"]);
    expect(new Set(Object.keys(doc.paths["/v1/me/resume/pdf"].put.requestBody.content))).toEqual(
      new Set(["application/json", "multipart/form-data", "application/pdf"]),
    );
    expect(doc.paths["/v1/applications/{application_id}/resume.pdf"].get.security).toEqual([{ bearer: ["recruiter:read"] }]);
  });

  it("每个工具只定义一次，并且都排进了工具列表", () => {
    const defined = [...candidateOps, ...jobOps, ...subscriptionOps, ...applicationOps].map((op) => op.name);
    const listed = OPS.map((op) => op.name);
    expect(new Set(defined).size).toBe(defined.length);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(listed)).toEqual(new Set(defined));
  });

  it("MCP 的服务端版本取自 package.json", async () => {
    const token = await login(unique("ver"), CANDIDATE);
    const init = await mcp(token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.data.result.serverInfo.version).toBe(pkg.version);
  });
});
