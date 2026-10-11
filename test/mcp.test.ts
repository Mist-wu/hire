import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { BASE, CANDIDATE, RECRUITER, internJob, login, mcp, profile, setup, unique } from "./helpers";

describe("MCP", () => {
  it("没有令牌时返回 401 和资源元数据地址", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    const meta = await (await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json<any>();
    expect(meta.authorization_servers).toEqual([BASE]);
  });

  it("握手并按令牌范围列出工具", async () => {
    const name = unique("mcp");
    const seeker = await login(name, CANDIDATE);
    const init = await mcp(seeker, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.data.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "hire" } });

    const names = async (token: string, path?: string) =>
      (await mcp(token, "tools/list", {}, path)).data.result.tools.map((t: any) => t.name);
    const candidateTools = await names(seeker);
    expect(candidateTools).toContain("application_create");
    expect(candidateTools).not.toContain("job_create");
    expect(candidateTools).toHaveLength(17);
    expect(await names(await login(name, RECRUITER))).toHaveLength(17);
    const all = await login(name);
    expect(await names(all)).toHaveLength(29);
    expect(await names(all, "/mcp/recruiter")).toHaveLength(17);
    expect(await names(await login(name, "candidate:read"))).toEqual([
      "profile_get", "jobs_search", "job_get", "subscriptions_list", "applications_list", "application_get", "events_poll", "quota_get",
    ]);

    const tools = (await mcp(all, "tools/list", {})).data.result.tools;
    const search = tools.find((t: any) => t.name === "jobs_search");
    expect(search.annotations.readOnlyHint).toBe(true);
    expect(search.inputSchema.properties.recruit_type.enum).toContain("intern_daily");
    expect(tools.filter((t: any) => t.annotations.readOnlyHint)).toHaveLength(12);
    expect(tools.find((t: any) => t.name === "application_get").annotations.readOnlyHint).toBe(false);
  });

  it("调用工具，出错时返回可读的错误", async () => {
    const { seeker, job } = await setup();
    const ok = await mcp(seeker, "tools/call", { name: "job_get", arguments: { job_id: job.id } });
    expect(ok.data.result.structuredContent.job.title).toBe(internJob.title);
    expect(JSON.parse(ok.data.result.content[0].text).job.id).toBe(job.id);

    const bad = await mcp(seeker, "tools/call", { name: "jobs_search", arguments: { recruit_type: "nope" } });
    expect(bad.data.result.isError).toBe(true);
    expect(JSON.parse(bad.data.result.content[0].text).error.code).toBe("validation_failed");

    const forbidden = await mcp(seeker, "tools/call", { name: "job_create", arguments: internJob });
    expect(JSON.parse(forbidden.data.result.content[0].text).error.code).toBe("forbidden_scope");
    const wrongRole = await mcp(seeker, "tools/call", { name: "job_create", arguments: internJob }, "/mcp/candidate");
    expect(wrongRole.data.error.code).toBe(-32602);
    expect((await mcp(seeker, "nope/method")).data.error.code).toBe(-32601);

    const note = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${seeker}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    expect((await SELF.fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${seeker}` } })).status).toBe(405);
  });

  it("官方 SDK 客户端能连上并调用工具", async () => {
    const seeker = await login(unique("sdk"), CANDIDATE);
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: (url, init) => SELF.fetch(url as string, init as RequestInit),
      requestInit: { headers: { Authorization: `Bearer ${seeker}` } },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    const updated = await client.callTool({ name: "profile_update", arguments: profile });
    expect((updated.structuredContent as any).profile.name).toBe("林晓");
    const result = await client.callTool({ name: "jobs_search", arguments: { city: "北京", limit: 1 } });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});
