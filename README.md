# dsh 开源聚合代理（dsh-openai-aggregate-proxy）

为 **DeepSeek Harness (dsh)** 设计的本地 OpenAI 兼容**聚合代理**：把多个上游模型网关（任意 OpenAI 兼容 API）暴露成一套标准接口，dsh 通过一个 provider 即可按模型名自动路由到不同上游。

## 🚀 用 WorkBuddy 自动部署（最简单的上手方式）

**你只需要两样东西：** ① 一个上游 API key（见下方"获取 key"）；② 把这个链接发给你的 WorkBuddy：

```
https://github.com/huwxmax-eng/dsh-openai-aggregate-proxy
```

配合这句话（把 `<你的key>` 换成你自己的）：

> 请按 https://github.com/huwxmax-eng/dsh-openai-aggregate-proxy 仓库的 WORKBUDDY_DEPLOY.md 自动部署这个项目，我的上游 API key 是：`<你的key>`

WorkBuddy（或任意 AI 助手）会自动完成：**克隆 → 检查 Node → 生成配置 → 填你的 key → 启动代理 → 验证 → 接入 dsh**，最后把结果汇报给你。全程约 5 分钟，不需要自己敲命令。

## 🔑 如何获取自己的 API key（腾讯云 TokenHub / Token Plan）

腾讯云 **TokenHub / Token Plan** 是"包月/配额 Token"体系，按模型抵扣、DeepSeek V4 Flash/Pro 原厂直供，兼容 OpenAI / Anthropic 协议，适合 dsh、codex、cursor 等编程/智能体工具。**新注册用户默认有 2000 万 token 免费额度，无需绑卡**。

| 档位 | 月费 | 月度 Tokens | 适合 |
|---|---|---|---|
| 新用户免费额度 | ¥0 | 2,000 万 | 首次体验 |
| Lite | ¥39 | 3,500 万 | 轻度使用（约 70 轮问答） |
| Standard | ¥99 | 1 亿 | 日常使用（约 200 轮） |
| Pro | ¥299 | 3.2 亿 | 高频 AI 开发 |
| Max | ¥599 | 6.5 亿 | 重度 AI 开发 |

**获取步骤：**
1. 注册/登录腾讯云：https://cloud.tencent.com（新用户送 2000 万 token 免费额度）
2. 打开 **API Key 管理** 页面（不是 WorkBuddy 客户端，是腾讯云控制台 TokenHub 页面）：
   - 国际版：https://console.tencentcloud.com/tokenhub/apikey
   - 国内版：登录 https://console.cloud.tencent.com 后搜索 "TokenHub / API Key"
3. 点击「**创建 API Key**」
4. 如创建时有"访问范围"选项，**务必勾选 `deepseek-v4-flash` 和 `deepseek-v4-pro`**
5. 复制并妥善保管生成的 `ck_` 开头 key
6. 把 key 交给 WorkBuddy 自动部署时填上，或手动填进 `config.json` 的 `upstreams[].apiKey`

> 若配置在 WorkBuddy 自定义模型里，接口地址填：`https://tokenhub.tencentcloudmaas.com/v1/chat/completions`
> 注意：WorkBuddy 应用内的"积分"（签到/礼包/邀请）是另一套体系，**不能导出为 API key**；本项目用的是上述 API Key。
> 也支持 DeepSeek 官方 key（`sk_` 开头，api.deepseek.com 按量付费）或任意 OpenAI 兼容服务。

## 解决什么问题

dsh（DeepSeek Harness）通过 OpenAI 兼容协议对接模型服务。当你有多个上游（官方 API、聚合站、本地模型等）时，本代理让你：

- **一个 provider 管所有**：dsh 里只配一个 `openai-completions` 源，按 model 名分发到不同上游
- **协议兼容**：统一处理流式、工具调用、usage 格式
- **密钥不外泄**：上游 key 只存在本地 config.json，dsh 侧只用一把本地代理 key

## 特性

- 零依赖，单文件 Node（仅需 Node 18+）
- 只监听 `127.0.0.1`，调用方需 `Authorization: Bearer <proxyKey>`
- 多上游按 model 路由（fallback 到第一个上游）
- 支持流式 / 非流式；支持工具调用（function calling）
- 上游无 `/models` 路由时，由代理静态返回模型目录

## 快速开始

```bash
# 1. 安装配置
cp config.example.json config.json
# 编辑 config.json：填 proxyKey 和 upstreams（可配多个上游，按 model 分流）

# 2. 启动
node server.mjs

# 3. 验证
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer <proxyKey>"
```

## dsh 接入配置

### `~/.dsh/.credentials.yaml`（凭据，0600）

```yaml
WB_BRIDGE_KEY: <proxyKey>   # 本地代理 key
```

### `~/.dsh/settings.yaml`（provider 路由）

```yaml
llm-pi-ai:
  providers:
    my-proxy:
      displayName: My Proxy
      apiKeyEnv: WB_BRIDGE_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:8787/v1
      models:
        - id: deepseek-v4-flash
          name: DeepSeek-V4-Flash
        - id: deepseek-v4-pro
          name: DeepSeek-V4-Pro
```

改完 settings.yaml 重启 dsh web，模型下拉里就会出现 `my-proxy` 组。

> **⚠️ 注意：本仓库没有 dsh 插件形态，请勿把任何 `plugin/` 目录安装为 dsh 插件。**
> 代理以独立进程运行（`node server.mjs`），dsh 通过上面的 provider 路由（`openai-completions` + `baseURL`）接入即可。
> 误装插件会导致 dsh 启动崩溃（`Cannot find package '@deepseek-ai/schemastery'`），从 `~/.dsh/profiles/web/cordis.patch.yml` 移除该条目即可恢复。

## config.json 字段

| 字段 | 说明 |
|---|---|
| `proxyKey` | 本地代理鉴权 token（调用方 Bearer 头） |
| `defaultModel` | 未指定模型时的默认值 |
| `upstreams[]` | 上游列表，按 `models` 匹配路由 |
| `upstreams[].url` | 上游 chat/completions 地址 |
| `upstreams[].apiKey` | 上游鉴权 key |
| `upstreams[].userId` | 可选：需要额外用户头时使用（如某些网关要 `X-User-Id`） |
| `upstreams[].models` | 该上游负责的模型 id 列表 |

## 多上游示例

```json
{
  "upstreams": [
    {
      "name": "official-deepseek",
      "url": "https://api.deepseek.com/v1/chat/completions",
      "apiKey": "sk-xxx",
      "models": ["deepseek-v4-flash", "deepseek-v4-pro"]
    },
    {
      "name": "local-ollama",
      "url": "http://127.0.0.1:11434/v1/chat/completions",
      "apiKey": "ollama",
      "models": ["local-model"]
    }
  ]
}
```

## 安全提示

- 仅监听 127.0.0.1，不要把端口暴露到公网
- 配置里的上游 key 不要提交到仓库（建议 `.gitignore` config.json）
- 请遵守各上游服务商的服务条款

## License

MIT
