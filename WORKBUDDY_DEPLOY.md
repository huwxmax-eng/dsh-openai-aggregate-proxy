# WorkBuddy 自动部署指令

> 把本文件对应的仓库链接 + 下面的启动句发给你的 WorkBuddy（或任意 AI 助手），它会按本文件自动完成部署。
> 本文件是给 AI agent 看的**执行清单**，不是给人类的教程（人类请看 README.md）。

## 启动句（用户发给 AI 助手的一句话）

> 请按 https://github.com/huwxmax-eng/dsh-openai-aggregate-proxy 仓库的 WORKBUDDY_DEPLOY.md 自动部署这个项目，我的上游 API key 是：`<用户自己提供的 key>`

> 如果用户**还没有 key**，用下面的启动句（AI 会引导用户现场创建一个）：
>
> > 请按 https://github.com/huwxmax-eng/dsh-openai-aggregate-proxy 仓库的 WORKBUDDY_DEPLOY.md 自动部署这个项目，我还没有 API key，请先引导我创建一个。

## 执行清单

### 0. 引导用户获取自己的 API Key（如果用户没有）

**重要事实**：这个项目的上游 key 来自腾讯云 **TokenHub / Token Plan**（与 WorkBuddy 同一腾讯云账号体系）。**新注册用户默认有 2000 万 token 免费额度，无需绑卡**。AI 助手负责引导，创建动作必须用户本人完成（涉及登录与密钥保管）。

引导步骤（AI 逐步执行，每步等用户确认）：
0.1 **先问用户是否已有现成的 key**：WorkBuddy 新用户可能**自动获得**一把 API key（无需手动创建）。让用户检查 WorkBuddy 客户端「设置 → 模型 → 自定义模型」或腾讯云 TokenHub API Key 管理页是否已存在 key：
   - 有 → 让用户复制现有 key 给 AI，跳到第 1 步
   - 没有 → 继续下面引导创建
0.2 询问用户是否已有腾讯云账号：
   - 有 → 直接下一步
   - 没有 → 请用户打开 https://cloud.tencent.com 注册（AI 可以帮忙打开浏览器，但注册/登录由用户本人完成）
0.3 **打开 API Key 管理页面**（不是 WorkBuddy 客户端个人中心，是腾讯云控制台 TokenHub 页面）：
   - 国际版：https://console.tencentcloud.com/tokenhub/apikey
   - 国内版：登录 https://console.cloud.tencent.com 后在搜索框搜"TokenHub / API Key"
0.4 点击「**创建 API Key**」：
   - 如果创建时有"访问范围/限定范围"选项，**务必勾选 `deepseek-v4-flash` 和 `deepseek-v4-pro`**
   - 其他选项按默认即可
0.5 创建完成后让用户**复制并妥善保管**这把 `ck_` 开头的 key（提示：不要外泄，token 会被用光）
0.6 用户把 key 粘贴给 AI 后，**只写入本机 config.json**，严禁写入聊天记录以外的任何公开位置
0.7 继续第 1 步部署

**引导时给用户的参考信息**（官方文档依据）：
- TokenHub 接口地址（若用户问"这 key 配什么地址"）：`https://tokenhub.tencentcloudmaas.com/v1/chat/completions`
- 免费额度说明：新用户 2000 万 token（无需绑卡）；WorkBuddy 应用内积分（签到/邀请/礼包）是另一套体系，**不能导出为 key**，本项目用的是 API Key

### 1. 克隆仓库
```bash
mkdir -p "$HOME/Desktop/工具" 2>/dev/null
cd "$HOME/Desktop/工具"
git clone https://github.com/huwxmax-eng/dsh-openai-aggregate-proxy.git dsh-openai-aggregate-proxy 2>/dev/null || echo "目录已存在"
cd dsh-openai-aggregate-proxy
```

### 2. 检查 Node.js（需要 18+）
```bash
node --version
```
- 如果不存在或版本 <18：优先用 Homebrew（`brew install node`）；没有 brew 则提示用户，不要擅自下载安装包。
- 不要使用 sudo。

### 3. 生成配置文件
```bash
cp config.example.json config.json
chmod 600 config.json
```
生成一把本地代理密钥（proxyKey）：
```bash
PROXY_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | head -c 32)
echo "本地代理 key 为：$PROXY_KEY（请记下，配置 dsh 时要填）"
```

### 4. 填写 config.json
- `proxyKey`：上一步生成的 `$PROXY_KEY`
- `upstreams[].url`：根据用户提供的 key 类型选择：
  - **腾讯云 Token Plan key（ck_ 开头）**：`https://copilot.tencent.com/v2/chat/completions`（腾讯云 Token Plan 的 OpenAI 兼容调用端点，**实测可用**），并在 `upstreams[].userId` 填用户自己的用户标识（如果用户提供了）；模型填 `deepseek-v4-flash` / `deepseek-v4-pro` 等
  - **DeepSeek 官方 key（sk_ 开头）**：`https://api.deepseek.com/v1/chat/completions`，模型填 `deepseek-v4-flash` / `deepseek-v4-pro`
  - 其他 OpenAI 兼容服务：按其官方地址填写
- `upstreams[].apiKey`：**用户提供的 key**
- `upstreams[].models`：按用户需求填模型 id（默认 `deepseek-v4-flash`、`deepseek-v4-pro`）

**重要**：key 必须由用户亲自提供，禁止从任何文件/环境变量里猜测或读取别人的 key。

### 5. 启动代理（后台常驻）
```bash
nohup node server.mjs --port 8787 </dev/null >> server.log 2>&1 &
sleep 2
```

### 6. 验证
```bash
# 健康检查
curl -s http://127.0.0.1:8787/health -H "Authorization: Bearer $PROXY_KEY"
# 模型目录
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $PROXY_KEY"
# 真实对话（消耗用户额度，用最小 token）
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"只回复两个字：正常"}],"max_tokens":10}'
```
- 健康检查 200 + 模型目录有模型 + 对话返回内容 = 部署成功
- 若上游报错（如 401/403），把完整错误告诉用户，指导检查 key

### 7.（可选）接入 dsh（DeepSeek Harness）
如果用户装了 dsh 并要求接入：
1. `~/.dsh/.credentials.yaml` 追加：`WB_BRIDGE_KEY: <PROXY_KEY>`
2. `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 追加（保留原有 providers）：
```yaml
llm-pi-ai:
  providers:
    wb-bridge:
      displayName: WorkBuddy Token 桥
      apiKeyEnv: WB_BRIDGE_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:8787/v1
      models:
        - id: deepseek-v4-flash
          name: DeepSeek-V4-Flash
        - id: deepseek-v4-pro
          name: DeepSeek-V4-Pro
```
3. 重启 dsh web（如 `dsh web`），验证 `llm.models` 里出现 wb-bridge 组
4. 若用户没有 dsh，跳过此步

### 8. 汇报
向用户输出：
- 代理地址：`http://127.0.0.1:8787`（仅本机）
- 本地代理 key：`$PROXY_KEY`（提醒保密）
- 是否接入 dsh 成功
- 使用方法一句话：任何 OpenAI 兼容客户端填 base_url + Bearer key 即可

## 注意事项
- 只监听 127.0.0.1，禁止把端口暴露到公网
- config.json 权限保持 600
- 不要上传/泄露用户提供的 key 到任何地方（包括不要提交到 git）
- 遇到任何一步失败：停下并向用户说明原因，不要跳过验证
