/**
 * dsh-openai-aggregate-proxy — DeepSeek Harness 插件（零依赖版）
 *
 * 作用：
 * 1. 读取配置 ~/.dsh/openai-aggregate-proxy/config.json
 * 2. 拉起本地 OpenAI 兼容聚合代理（server.mjs）
 * 3. 把本地代理 key 写进 ~/.dsh/.credentials.yaml（AGG_PROXY_KEY）
 * 4. 插件卸载/退出时自动停掉代理进程
 *
 * 配置（config.json，由用户或 WorkBuddy 生成）：
 * {
 *   "port": 8787,
 *   "upstreamUrl": "https://copilot.tencent.com/v2/chat/completions",
 *   "apiKey": "ck_... 或 sk_...",
 *   "userId": "可选",
 *   "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
 *   "localKey": "本地代理 key（可选，默认自动生成）"
 * }
 *
 * provider 注册（llm-pi-ai.providers）由用户在 dsh 设置或
 * settings.yaml 里配置（见 README），插件不自动改写 settings.yaml，
 * 避免破坏用户配置。本插件刻意零依赖（只用 Node 内置模块）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const name = 'dsh-openai-aggregate-proxy';

export function apply(ctx) {
  const home = os.homedir();
  const dataDir = path.join(home, '.dsh', 'openai-aggregate-proxy');
  const configPath = path.join(dataDir, 'config.json');
  const serverPath = path.join(__dirname, 'server.mjs');
  const credPath = path.join(home, '.dsh', '.credentials.yaml');

  let proc = null;

  function readConfig() {
    if (!fs.existsSync(configPath)) {
      ctx.logger?.warn?.('[agg-proxy] 未找到配置，请创建', configPath);
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      ctx.logger?.warn?.('[agg-proxy] 配置解析失败:', e.message);
      return null;
    }
  }

  function ensureCredential(localKey) {
    if (!fs.existsSync(credPath)) fs.writeFileSync(credPath, '', { mode: 0o600 });
    let content = fs.readFileSync(credPath, 'utf8');
    if (!content.includes('AGG_PROXY_KEY')) {
      fs.appendFileSync(credPath, `AGG_PROXY_KEY: ${localKey}\n`, { mode: 0o600 });
    }
  }

  function startServer() {
    const cfg = readConfig();
    if (!cfg) return;
    const port = cfg.port ?? 8787;
    const localKey = cfg.localKey && cfg.localKey !== 'auto'
      ? cfg.localKey
      : crypto.randomBytes(18).toString('base64url');
    fs.mkdirSync(dataDir, { recursive: true });
    // 写回完整配置（含自动生成的 localKey）
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, port, localKey }, null, 2), { mode: 0o600 });
    ensureCredential(localKey);

    proc = spawn(process.execPath, [serverPath, '--port', String(port)], {
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WB_BRIDGE_CONFIG: configPath },
      detached: false,
    });
    proc.stdout?.on('data', (d) => ctx.logger?.debug?.('[agg-proxy]', String(d).trim()));
    proc.stderr?.on('data', (d) => ctx.logger?.warn?.('[agg-proxy]', String(d).trim()));
    proc.on('exit', (code) => {
      ctx.logger?.info?.('[agg-proxy] 代理进程退出 code=', code);
      proc = null;
    });
    ctx.logger?.info?.(`[agg-proxy] 代理已启动 http://127.0.0.1:${port}`);
  }

  startServer();

  ctx.on('dispose', () => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });
}
