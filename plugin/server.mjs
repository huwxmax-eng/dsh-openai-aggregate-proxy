#!/usr/bin/env node
/**
 * openai-aggregate-proxy — 本地 OpenAI 兼容聚合代理。
 * 把多个上游模型网关（任意 OpenAI 兼容 API）暴露为标准
 * OpenAI /v1/chat/completions 与 /v1/responses 接口，供任意外部 agent
 *（dsh / 任意 OpenAI 兼容客户端）使用。按 model 名路由到对应上游。
 *
 * 解决的核心问题：dsh 等 agent 只认 OpenAI Responses API，而很多上游
 * 只有 chat/completions 协议 —— 本代理做协议翻译 + 多上游路由。
 *
 * 用法:
 *   node server.mjs [--port 8787]
 * 环境变量: WB_BRIDGE_CONFIG 指向 config.json（默认同目录 config.json）
 *
 * 安全: 仅监听 127.0.0.1；所有调用方需带 Authorization: Bearer <proxyKey>
 *（config.json 中 proxyKey），上游密钥绝不外泄。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.WB_BRIDGE_CONFIG || path.join(__dirname, 'config.json');

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error('[openai-aggregate-proxy] 无法读取 config.json:', e.message);
  process.exit(1);
}

const PORT = Number(process.argv[2] === '--port' ? process.argv[3] : cfg.port ?? 8787);
const LISTEN = cfg.listen || '127.0.0.1';
const PROXY_KEY = cfg.proxyKey;
const DEFAULT_MODEL = cfg.defaultModel || 'deepseek-v4-flash';

// 上游列表：兼容旧单上游配置（upstream/upstreamApiKey/upstreamUserId/models）
const UPSTREAMS = Array.isArray(cfg.upstreams) && cfg.upstreams.length
  ? cfg.upstreams
  : [{
      name: cfg.upstreamName || 'default',
      url: cfg.upstream || 'http://127.0.0.1:9999/v1/chat/completions',
      apiKey: cfg.upstreamApiKey,
      userId: cfg.upstreamUserId,
      models: cfg.models || ['default-model'],
    }];

// 按 model 路由到上游：精确匹配列表；否则 fallback 第一个
function resolveUpstream(model) {
  const m = model || DEFAULT_MODEL;
  for (const u of UPSTREAMS) {
    if ((u.models || []).includes(m)) return u;
  }
  return UPSTREAMS[0];
}

// 向外部 agent 暴露的模型目录（聚合所有上游）
const MODELS = UPSTREAMS.flatMap(u =>
  (u.models || []).map(id => ({ id, object: 'model', owned_by: u.name }))
);

function log(...a) { console.log(new Date().toISOString(), ...a); }

function authOk(req) {
  if (!PROXY_KEY) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${PROXY_KEY}`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ---------- 上游转发（统一强制 stream=true，兼容只支持流式的上游） ----------
function upstreamRequest(payload, upstream, timeoutMs = 600000) {
  const u = new URL(upstream.url);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ...payload, stream: true });
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${upstream.apiKey}`,
      'Content-Length': Buffer.byteLength(body),
    };
    if (upstream.userId) headers['X-User-Id'] = upstream.userId;
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, res => resolve(res));
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 把上游 SSE 流切成 data 行
async function* readSSE(res) {
  let buf = '';
  for await (const chunk of res) {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data && data !== '[DONE]') yield JSON.parse(data);
        else if (data === '[DONE]') return;
      }
    }
  }
}

function accumulateCompletion(chunks) {
  const msg = { role: 'assistant', content: '', tool_calls: [] };
  const byIndex = new Map();
  let usage = null, finish = '';
  for (const c of chunks) {
    if (c.usage) usage = c.usage;
    const ch = c.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || {};
    if (d.content) msg.content += d.content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        if (!byIndex.has(i)) byIndex.set(i, { id: tc.id || `call_${i}`, type: 'function', function: { name: '', arguments: '' } });
        const t = byIndex.get(i);
        if (tc.id) t.id = tc.id;
        if (tc.function?.name) t.function.name += tc.function.name;
        if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
      }
    }
  }
  msg.tool_calls = [...byIndex.values()];
  return { message: msg, finish_reason: finish, usage };
}

// ---------- chat/completions ----------
async function handleChat(req, res, body) {
  const wantStream = body.stream === true;
  const upstream = resolveUpstream(body.model);
  log(`[chat] model=${body.model} -> upstream=${upstream.name}`);
  const upstreamRes = await upstreamRequest({ ...body, stream: true }, upstream);
  if (upstreamRes.status >= 400) {
    const text = await upstreamRes.text().catch(() => '');
    sendJson(res, upstreamRes.status, { error: { message: `upstream ${upstream.name} ${upstreamRes.status}: ${text.slice(0, 300)}` } });
    return;
  }
  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    upstreamRes.pipe(res);
    return;
  }
  // 非流式：聚合后返回标准 JSON
  const chunks = [];
  for await (const c of readSSE(upstreamRes)) chunks.push(c);
  const { message, finish_reason, usage } = accumulateCompletion(chunks);
  sendJson(res, 200, {
    id: `cmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: body.model || DEFAULT_MODEL, choices: [{ index: 0, message, finish_reason }], usage,
  });
}

// ---------- Responses API ----------
function toChatMessages(input) {
  const msgs = [];
  if (typeof input === 'string') {
    msgs.push({ role: 'user', content: input });
    return msgs;
  }
  for (const it of input || []) {
    if (typeof it === 'string') { msgs.push({ role: 'user', content: it }); continue; }
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call') {
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: it.call_id || it.id, type: 'function', function: { name: it.name, arguments: it.arguments || '{}' } }] });
    } else if (it.type === 'function_call_output') {
      msgs.push({ role: 'tool', tool_call_id: it.call_id, content: String(it.output ?? '') });
    } else if (it.type === 'message' || it.role) {
      const role = (it.role === 'developer') ? 'user' : it.role;
      if (Array.isArray(it.content)) {
        const text = it.content.filter(p => p?.type === 'input_text' || p?.type === 'output_text' || p?.type === 'text')
          .map(p => p.text || '').join('');
        msgs.push({ role, content: text });
      } else {
        msgs.push({ role, content: String(it.content ?? '') });
      }
    }
  }
  return msgs;
}

function toChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    let name = t.name || t.function?.name;
    if (!name) continue; // 过滤无名字的工具（如 web_search 特殊类型），避免上游校验失败
    if (t.type === 'function' && t.function) { out.push(t); continue; }
    out.push({ type: 'function', function: { name, description: t.description || '', parameters: t.parameters || t.input_schema || { type: 'object', properties: {} } } });
  }
  return out.length ? out : undefined;
}

function responsesId() { return `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function itemId(p) { return `it_${p}`; }

// chat usage -> Responses API usage（Responses 协议要求 input_tokens/output_tokens）
function toResponsesUsage(usage) {
  if (!usage) return undefined;
  const i = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const o = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: i,
    output_tokens: o,
    total_tokens: usage.total_tokens ?? i + o,
    input_tokens_details: usage.prompt_tokens_details ?? { cached_tokens: usage.cached_tokens ?? 0 },
    output_tokens_details: usage.completion_tokens_details ?? {},
  };
}

function sse(res, event, obj) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}

async function handleResponses(req, res, body) {
  const stream = body.stream === true;
  const rid = responsesId();
  const model = body.model || DEFAULT_MODEL;
  const upstream = resolveUpstream(model);
  log(`[responses] model=${model} -> upstream=${upstream.name} stream=${stream} inputType=${typeof body.input} inputLen=${Array.isArray(body.input) ? body.input.length : String(body.input||'').length} tools=${Array.isArray(body.tools) ? body.tools.length : 0} prevResp=${body.previous_response_id || '-'} store=${body.store ?? '-'}`);
  try {
    const msgs = toChatMessages(body.input);
    log(`[responses] msgs=${msgs.map(m => `${m.role}:${String(m.content||'').slice(0,30)}${m.tool_call_id?'[tc]':''}${m.tool_calls?'[call]':''}`).join(' | ')}`);
    const t = toChatTools(body.tools);
    if (t) log(`[responses] tools=${t.map(x => `${x.function?.name}`).join(',')}`);
  } catch (e) { log('[responses] body-parse-warn:', e.message); }
  const payload = {
    model,
    messages: toChatMessages(body.input),
    stream: true,
    max_tokens: body.max_output_tokens ?? undefined,
    temperature: body.temperature,
    top_p: body.top_p,
  };
  const tools = toChatTools(body.tools);
  if (tools) payload.tools = tools;
  if (body.instructions) payload.messages.unshift({ role: 'system', content: body.instructions });

  const upstreamRes = await upstreamRequest(payload, upstream);
  if (upstreamRes.status >= 400) {
    const text = await upstreamRes.text().catch(() => '');
    sendJson(res, upstreamRes.status, { error: { message: `upstream ${upstream.name} ${upstreamRes.status}: ${text.slice(0, 300)}` } });
    return;
  }

  const chunks = [];
  for await (const c of readSSE(upstreamRes)) chunks.push(c);
  const { message, finish_reason, usage } = accumulateCompletion(chunks);
  const created = Math.floor(Date.now() / 1000);

  const outputs = [];
  if (message.content) {
    outputs.push({ type: 'message', id: itemId('msg'), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  }
  for (const tc of message.tool_calls || []) {
    outputs.push({ type: 'function_call', id: itemId(`fc_${tc.function.name}`), call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '', status: 'completed' });
  }

  if (!stream) {
    log(`[responses] done(no-stream) id=${rid} outputs=${outputs.length} usage=${JSON.stringify(usage)}`);
    sendJson(res, 200, {
      id: rid, object: 'response', created_at: created, status: 'completed',
      model, output: outputs, usage: toResponsesUsage(usage),
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const rUsage = toResponsesUsage(usage);
  sse(res, 'response.created', { type: 'response.created', response: { id: rid, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });
  for (const o of outputs) {
    const idx = outputs.indexOf(o);
    // added 事件：item 带最小完整结构（content 数组必须有），status 用 in_progress
    const addedItem = o.type === 'message'
      ? { id: o.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
      : { id: o.id, type: 'function_call', status: 'in_progress', call_id: o.call_id, name: o.name, arguments: '' };
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: idx, item: addedItem });
    if (o.type === 'message') {
      sse(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: o.id, output_index: idx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: o.id, output_index: idx, content_index: 0, delta: o.content[0].text });
      sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: o.id, output_index: idx, content_index: 0, text: o.content[0].text });
      sse(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: o.id, output_index: idx, content_index: 0, part: { type: 'output_text', text: o.content[0].text, annotations: [] } });
    } else {
      sse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: o.id, output_index: idx, delta: o.arguments });
      sse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: o.id, output_index: idx, arguments: o.arguments });
    }
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: idx, item: o });
  }
  sse(res, 'response.completed', { type: 'response.completed', response: { id: rid, object: 'response', created_at: created, status: 'completed', model, output: outputs, usage: rUsage } });
  res.write('data: [DONE]\n\n');
  res.end();
  log(`[responses] done(stream) id=${rid} outputs=${outputs.length} events=${outputs.length * 4 + 2}`);
}

// ---------- 路由 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  log(`REQ ${req.method} ${url.pathname} ua=${req.headers['user-agent']?.slice(0,40)}`);
  if (!authOk(req)) { sendJson(res, 401, { error: { message: 'invalid proxy key' } }); return; }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: MODELS });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(data);
        await handleChat(req, res, body);
      } catch (e) {
        log('[chat] error:', e.message);
        sendJson(res, 400, { error: { message: e.message } });
      }
    });
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(data);
        await handleResponses(req, res, body);
      } catch (e) {
        log('[responses] error:', e.message);
        sendJson(res, 400, { error: { message: e.message } });
      }
    });
    return;
  }
  sendJson(res, 404, { error: { message: `no route: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, LISTEN, () => {
  log(`[dsh-aggregate-proxy] listening on http://${LISTEN}:${PORT}  upstreams=${UPSTREAMS.map(u => u.name).join(',')}  model=${DEFAULT_MODEL}`);
});
