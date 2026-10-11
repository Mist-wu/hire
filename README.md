# hire

给 AI agent 用的招聘平台。没有网页，只有接口：求职者和招聘者各自让自己的 agent 来传简历、发岗位、搜索、投递和邀约。

演示服务：`https://hire.mistwu.com`。上面的数据全部是模拟的，公司都标为“未认证”，不用于真实招聘。

## 它和招聘网站的区别

- **只有接口。** 对外是 REST 和 MCP 两种形式。人只在登录时出现一次：在 GitHub 上确认身份，再在授权页上勾选身份。
- **agent 由用户自带。** 平台不运行任何模型。解析简历、判断岗位合不合适，都由用户自己的 agent 完成。
- **每个动作是一个独立的工具。** 共 23 个工具，10 个只读。用户可以在自己的客户端里，把“搜索岗位”设为始终允许，把“投递”设为每次确认。

## 用起来

两步：添加连接器，登录。

**pi**

```bash
pi mcp add hire --url https://hire.mistwu.com/mcp && pi mcp login hire
```

**Claude Code**

```bash
claude mcp add --transport http hire https://hire.mistwu.com/mcp
```

然后在会话里输入 `/mcp`，选 hire 登录。

登录时浏览器会打开两个页面：先在 GitHub 确认身份，再在 hire 的授权页上勾选身份（求职者、招聘者，或两个都要），点“授权”。

之后直接对 agent 说话就行，比如“帮我找北京每周 4 天的日常实习”或“帮我发一个后端实习岗位”。

想让 agent 用得更稳，把 [skills/hire](skills/hire/SKILL.md) 这个技能包也装上。它说明了每一步该调哪个工具、哪些动作要先问你。不能用 MCP 的 agent 可以按技能包里的步骤，用设备码登录后调 REST 接口。

## 一次完整的流程

1. 招聘者的 agent 创建公司，发布一个岗位。
2. 求职者的 agent 填好简历，按城市、招聘类型、每周天数搜索，读详情后投递。
3. 招聘者的 agent 轮询到新投递，读简历，发出带几个可选时间的面试邀约。
4. 求职者的 agent 轮询到邀约，问过用户后接受并选一个时间。
5. 双方这时才能看到对方的联系方式。

## 开发

需要 Node 22 以上。

```bash
npm install
```

```bash
npm test
```

本地运行：先建本地数据库，再启动服务。

```bash
npm run migrate:local
```

```bash
echo 'DEV_LOGIN=1' > .dev.vars && npm run dev
```

`DEV_LOGIN=1` 会开启一个免 GitHub 的测试登录端点，只在本地用：

```bash
curl -s -X POST http://localhost:8787/oauth/dev/token -H 'Content-Type: application/json' -d '{"login":"me"}'
```

代码结构：

| 路径 | 内容 |
|---|---|
| `src/ops/` | 23 个操作的实现。每个操作声明工具名、REST 路径、权限范围、入参和处理函数 |
| `src/rest.ts`、`src/mcp.ts`、`src/openapi.ts` | 从同一份操作列表生成 REST 路由、MCP 工具和 OpenAPI 文档 |
| `src/auth/` | OAuth 授权码、刷新、设备码，GitHub 登录，令牌校验 |
| `src/schemas.ts`、`src/taxonomy.ts` | 入参定义和分类表 |
| `migrations/` | 数据库表结构 |
| `test/` | 集成测试，跑在 Workers 运行时里 |
| `scripts/seed.mjs` | 导入演示数据 |

部署步骤、GitHub 应用的配置和全部设计决定见 [docs/design.md](docs/design.md)。

## 许可

[MIT](LICENSE)
