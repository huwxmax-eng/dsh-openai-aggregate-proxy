# dsh 开源聚合代理（dsh-openai-aggregate-proxy）

为 **DeepSeek Harness (dsh)** 设计的本地 OpenAI 兼容**聚合代理**：把多个上游模型网关（任意 OpenAI 兼容 API）暴露成一套标准接口，dsh 通过一个 provider 即可按模型名自动路由到不同上游。

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
