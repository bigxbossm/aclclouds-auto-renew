#!/usr/bin/env node
/**
 * ACLClouds 免费 Bot 主机自动续期脚本(零依赖,Node >= 18)
 *
 * 原理(逆向自 aclclouds.com 前端 1459.js chunk):
 *   POST /api/client/servers/{id}/upgrade/renew
 *   - Laravel CSRF: 复用 cookie XSRF-TOKEN,放在 X-XSRF-TOKEN 请求头
 *   - 会话: cookie __Host-aclclouds_session(HttpOnly,需从浏览器导出)
 *   - 200 = 续期成功;400 renewal_not_available = 未到续期窗口(Free 套餐到期前 1 天开放)
 *   - 403 captcha_required = 站点要求人机验证,脚本无法自动处理
 *
 * 环境变量:
 *   ACL_SESSION   必填(或 ACL_EMAIL/ACL_PASSWORD) __Host-aclclouds_session cookie 值
 *   ACL_REMEMBER  可选  remember_web_... cookie 值(延长会话有效期)
 *   ACL_EMAIL     可选  邮箱(配合 ACL_PASSWORD 登录,实验性)
 *   ACL_PASSWORD  可选  密码
 *   ACL_SERVER_ID 可选  服务器 ID;缺省=自动发现所有 Free 服务并逐一续期
 *   ACL_BASE_URL  可选  默认 https://aclclouds.com
 *   DRY_RUN=1     可选  只查看状态,不实际续期
 */

const BASE = (process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(/\/+$/, '');
const SERVER_ID = process.env.ACL_SERVER_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const jar = {}; // name -> value

function setCookieFromHeader(h) {
  // h: "Name=Value; Path=/; ..."
  const m = h.match(/^([^=]+)=([^;]*)/);
  if (m) jar[m[1].trim()] = m[2];
}

function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(path, { method = 'GET', body, json = true, retry = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) aclclouds-renew/1.0',
      'Accept': json ? 'application/json' : 'text/html,application/xhtml+xml',
      'X-Requested-With': 'XMLHttpRequest',
      ...(jar['XSRF-TOKEN'] ? { 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN']) } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(Object.keys(jar).length ? { Cookie: cookieHeader() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  res.headers.getSetCookie?.().forEach(setCookieFromHeader);
  const text = await res.text();
  let data = null;
  try { data = json ? JSON.parse(text) : text; } catch { data = text; }
  // CSRF 过期自动重试一次(419)
  if (res.status === 419 && retry) {
    await warmup();
    return req(path, { method, body, json, retry: false });
  }
  return { status: res.status, data };
}

async function warmup() {
  // 访问首页拿 XSRF-TOKEN / session cookie
  await req('/', { json: false });
}

async function login() {
  const email = process.env.ACL_EMAIL, password = process.env.ACL_PASSWORD;
  if (!email || !password) return false;
  log('使用邮箱密码登录(实验性)…');
  const r = await req('/auth/login', { method: 'POST', body: { email, password } });
  if (r.status >= 200 && r.status < 300) { log('登录成功'); return true; }
  log(`登录失败: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return false;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function listServers() {
  const r = await req('/api/client/credits/subscriptions');
  if (r.status !== 200) throw new Error(`获取订阅列表失败: HTTP ${r.status}`);
  const subs = r.data.subscriptions || [];
  return subs.filter(s => s.kind === 'server' || s.plan_name);
}

async function renew(id) {
  const r = await req(`/api/client/servers/${id}/upgrade/renew`, { method: 'POST', body: {} });
  return r;
}

const REMEMBER_COOKIE = 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d';

function seedEnvCookies() {
  // 关键:先把导出的会话 cookie 放进 jar,再访问站点,
  // 否则 warmup() 会拿到匿名会话导致 401
  if (process.env.ACL_SESSION) jar['__Host-aclclouds_session'] = process.env.ACL_SESSION;
  if (process.env.ACL_REMEMBER) jar[REMEMBER_COOKIE] = process.env.ACL_REMEMBER;
}

async function ensureAuth() {
  seedEnvCookies();
  await warmup(); // 带 session 请求首页,刷新 XSRF-TOKEN(可能轮换 session,均记入 jar)
  if (process.env.ACL_SESSION) return true;
  return login();
}

async function main() {
  log(`目标: ${BASE}${SERVER_ID ? ` (server ${SERVER_ID})` : ' (自动发现)'}`);
  if (DRY_RUN) log('DRY_RUN 模式: 仅查看,不续期');

  const authed = await ensureAuth();
  if (!authed) {
    console.error('缺少会话: 请设置 ACL_SESSION(从浏览器导出 __Host-aclclouds_session cookie)或 ACL_EMAIL/ACL_PASSWORD');
    process.exit(1);
  }

  // 1) 确定目标服务器
  let targets = [];
  if (SERVER_ID) {
    targets = [{ id: SERVER_ID, name: SERVER_ID }];
  } else {
    const subs = await listServers();
    log(`发现 ${subs.length} 个服务: ${subs.map(s => `${s.name}(${s.id}, 到期 ${s.expires_at || '?'})`).join(', ')}`);
    targets = subs.map(s => ({ id: s.id, name: s.name, expires_at: s.expires_at }));
  }
  if (!targets.length) { log('没有可续期的服务'); process.exit(0); }

  // 2) 逐个续期
  let renewed = 0, skipped = 0, failed = 0;
  for (const t of targets) {
    if (DRY_RUN) { log(`[DRY] ${t.name} (${t.id}) 跳过续期`); continue; }
    log(`续期 ${t.name} (${t.id}) …`);
    const r = await renew(t.id);
    if (r.status === 200) {
      renewed++;
      const newExp = r.data?.expires_at || r.data?.server?.expires_at;
      log(`✅ 续期成功${newExp ? `,新到期时间: ${newExp}` : ''}`);
    } else if (r.status === 400 && r.data?.error === 'renewal_not_available') {
      skipped++;
      const d = r.data.days_remaining, h = r.data.hours_remaining;
      log(`⏳ 未到续期窗口(${d != null ? `还剩 ${d} 天` : h != null ? `还剩 ${h} 小时` : '时间未知'}),下次运行再试`);
    } else if (r.status === 403 && r.data?.code === 'captcha_required') {
      failed++;
      log('🤖 站点要求人机验证(captcha_required),请在浏览器完成一次后续期');
    } else if (r.status === 401) {
      log('会话失效(401),尝试用邮箱密码重新登录…');
      let retried = false;
      if (process.env.ACL_EMAIL && process.env.ACL_PASSWORD && await login()) {
        const r2 = await renew(t.id);
        if (r2.status === 200) { renewed++; log('✅ 重新登录后续期成功'); continue; }
        retried = true;
        log(`重试结果: HTTP ${r2.status} ${JSON.stringify(r2.data).slice(0, 200)}`);
      }
      if (!retried) {
        console.error('❌ 会话已失效且无法自动重新登录,请重新导出 ACL_SESSION cookie');
        process.exit(1);
      }
      failed++;
    } else {
      failed++;
      log(`⚠️ HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
    }
  }

  log(`完成: 成功 ${renewed},未到窗口 ${skipped},失败 ${failed}`);
  // exit code: 0=有成功或仅未到窗口(任务本身正常);1=需要人工介入
  if (failed > 0 && renewed === 0) process.exit(1);
}

main().catch(e => { console.error('执行异常:', e.message); process.exit(1); });
