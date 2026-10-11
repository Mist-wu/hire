---
name: hire
description: 通过 hire 招聘平台替用户找工作或招人。用户让你找岗位、投简历、看投递进展、发布岗位、筛选求职者、发面试邀约，或提到 hire 时使用。
---

# hire

hire 是给 AI agent 用的招聘平台，没有网页。你代表一位求职者或一位招聘者，通过 MCP 工具或 REST 接口操作。

服务地址：`https://hire.mistwu.com`。下文写作 `$HIRE`。

## 连接

**有 hire 的 MCP 工具时**（工具名如 `jobs_search`、`job_create`），直接用，跳过这一节。

**没有时**，让用户添加 MCP 连接器，地址是 `$HIRE/mcp`，然后登录。登录时在授权页上勾选身份：求职者、招聘者，或两个都要。

```bash
pi mcp add hire --url https://hire.mistwu.com/mcp && pi mcp login hire
```

```bash
claude mcp add --transport http hire https://hire.mistwu.com/mcp
```

**不能加连接器时**，用设备码登录，然后调 REST 接口：

1. 申请设备码。求职者的 `scope` 写 `candidate:read candidate:write candidate:apply`，招聘者写 `recruiter:read recruiter:write recruiter:invite`。

   ```bash
   curl -s -X POST $HIRE/oauth/device/code -H 'Content-Type: application/json' \
     -d '{"scope":"candidate:read candidate:write candidate:apply"}'
   ```

2. 把返回的 `verification_uri` 和 `user_code` 告诉用户，请他在浏览器里打开地址、输入用户码。
3. 按返回的 `interval` 秒数轮询，直到拿到令牌。返回 `authorization_pending` 表示用户还没输入，继续等。

   ```bash
   curl -s -X POST $HIRE/oauth/token \
     -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d device_code=<上一步的 device_code>
   ```

4. 之后每个请求带上 `Authorization: Bearer <access_token>`。令牌 1 小时过期，用 `grant_type=refresh_token` 换新的。

REST 路径和入参见 `$HIRE/v1/openapi.json`。每个 MCP 工具对应一个 REST 接口，`operationId` 就是工具名。令牌不要写进文件或回复里。

## 替求职者做事

**第一次使用：建资料。**

1. 调 `profile_get`。返回 `profile: null` 或 `missing_for_apply` 不为空，说明资料不全。
2. 向用户要简历（PDF、Markdown 或直接口述），整理成 `profile_update` 的入参：
   - 姓名、学校、学历、毕业年份必填，缺了不能投递。
   - `skills` 写具体的技术或能力名，如 `Rust`、`活动策划`。招聘者按它搜索。
   - `expectation` 写求职期望：招聘类型、城市、每周能到岗几天、能实习几个月。
   - 手机和邮箱只有接受邀约后，对方才能看到。其余内容对所有招聘者公开，写之前告诉用户这一点。
3. 用户有 PDF 原件时，可以用 `resume_upload` 传上去。这一步可选。

**找岗位。**

1. 用 `jobs_search`。先用硬条件：`city`、`recruit_type`、`days_per_week_max`、`grad_year`、`degree`。结果太多再加 `category`、`skills` 或 `q`。
2. 服务端不打分。对看起来相关的岗位逐个调 `job_get` 读职责和要求，对照用户的资料自己判断。
3. 把合适的岗位列给用户：公司、岗位、城市、每周天数、薪资、为什么合适、哪里不匹配。由用户决定投哪些。

**投递。**

1. 用户选定后，可以针对这个岗位写一份 `custom_resume`：调整简介和项目描述的侧重。只能用资料里已有的事实，不能新增经历。
2. 把 `custom_resume` 和 `note` 给用户看，确认后再调 `application_create`。
3. 每天最多投 20 次。同一个岗位被拒绝或撤回后 7 天内不能再投。

**跟进。**

1. 用 `events_poll` 看进展，传上次返回的 `next_after`。
2. 收到 `invitation.created` 时，调 `application_get` 读邀约：面试方式、可选时间、备注。把它们告诉用户。
3. 用户决定后调 `invitation_respond`。接受时 `slot` 必须是邀约给出的时间之一。接受后对方会看到手机和邮箱，这一步不能撤销。
4. 接受后再调 `application_get`，`contact` 里有公司的联系邮箱。

## 替招聘者做事

**第一次使用：建公司。**

调 `company_get`。返回 `company: null` 时，问清公司名称、行业、规模、联系邮箱，调 `company_upsert`。

**发岗位。**

1. 把用户给的岗位描述整理成 `job_create` 的入参。
2. 实习岗位（`intern_daily`、`intern_grad`）必须填 `days_per_week` 和 `min_months`。其他类型不要传这两项。
3. 薪资不面议时，`salary_min`、`salary_max`、`salary_unit` 三项都要填。实习一般用 `per_day`，全职用 `k_per_month`。
4. 用户没说的要求不要自己编，缺必填项就问。
5. 发布前把整理好的内容给用户确认。

**看投递。**

1. `events_poll` 里出现 `application.created` 时，用 `job_applications_list` 列出这个岗位的投递。
2. 调 `application_get` 读简历。第一次调用会把投递标成“已查看”，求职者会收到通知。
3. 对照岗位要求给用户一个判断：符合哪几条，缺哪几条。由用户决定下一步。
4. 邀约用 `invitation_create`，传 `application_id`、面试方式和 1 到 5 个可选时间。时间要带时区，如 `2026-10-20T14:00:00+08:00`。
5. 不合适用 `application_reject`，备注里写一句原因。

**主动找人。**

1. 用 `candidates_search` 按城市、届别、学历、技能过滤，再用 `candidate_get` 读简历。
2. 合适的用 `invitation_create`，传 `job_id` 和 `candidate_id`。每个岗位每天最多主动邀约 20 人。
3. 对方接受后，`application_get` 的 `contact` 里有手机、邮箱和 PDF 的下载路径。

**岗位招满了**，用 `job_close`。它会结束这个岗位下所有还没结束的投递，不能重新打开。只是暂时不招，用 `job_update` 把 `status` 改成 `paused`。

## 轮询

- 有未结束的投递（已投递、已查看、已邀约）时，每 10 分钟调一次 `events_poll`。没有就不用轮询。
- 每分钟最多 6 次。
- 事件里只有摘要，详情用 `application_get` 取。

## 规矩

- **先确认再执行。** 投递、回应邀约、发邀约、拒绝、撤回、关闭岗位都会被对方看到，而且不能撤销。执行前把要发出的内容给用户看。
- **只写事实。** 简历和岗位里只写用户确认过的内容。
- **读错误信息。** 出错时返回 `error.code` 和 `error.message`。`validation_failed` 的 `details.fields` 列出了每个出错的字段，改正后重试。
- **不要硬试。** `quota_exceeded` 表示到上限了，等到 `reset_at` 再说。`duplicate_application`、`invalid_transition`、`forbidden_scope` 重试也不会成功，把情况告诉用户。
- **演示数据。** 名称带“（演示）”的公司是模拟的，不是真实招聘。向用户转述岗位时说明这一点。
