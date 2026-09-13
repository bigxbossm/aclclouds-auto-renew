#!/usr/bin/env node
import { chromium } from 'playwright';
import Tesseract from 'tesseract.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(/\/+$/, '');
const USER = process.env.ACL_USERNAME || process.env.ACL_EMAIL || '';
const PASS = process.env.ACL_PASSWORD || '';
const SERVER_ID = process.env.ACL_SERVER_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const AUTH = path.resolve(process.env.ACL_AUTH_STATE || 'auth.json');
const SHOT = path.resolve('shots');
const VOCAB = [
  'Panel', 'VPS', 'Bot', 'Serveur', 'Cloud', 'ACLClouds',
  'Minecraft', 'Discord', 'Housing', 'Tunnel', 'Dedicated',
  'Free', 'Upgrade', 'Renew', 'Game', 'Node', 'Credit', 'Support'
];

fs.mkdirSync(SHOT, { recursive: true });
const shots = [];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function score(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return Math.max(0, 100 - dp[a.length][b.length] * 25);
}

function ocrScore(text, guess, prompt) {
  return Math.max(score(text, prompt), score(guess, prompt));
}

async function shot(page, name) {
  const p = path.join(SHOT, name);
  await page.screenshot({ path: p, fullPage: true });
  shots.push(p);
  log(`截图 ${name}`);
  return p;
}

async function sendTgPhoto(chat, token, photoPath, caption) {
  if (!photoPath || !fs.existsSync(photoPath) || fs.statSync(photoPath).size < 100) return;
  try {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/png' }), path.basename(photoPath));
    if (caption) form.append('caption', caption);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!r.ok) log(`TG 图片发送失败 ${path.basename(photoPath)}: ${await r.text()}`);
    else log(`TG 图片已发送: ${path.basename(photoPath)}`);
  } catch (e) {
    log(`TG 图片发送异常: ${e.message}`);
  }
}

async function tg(text, { photo = null } = {}) {
  const token = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (!token || !chat) {
    log('未配置 TG_BOT_TOKEN/TG_CHAT_ID,跳过通知');
    return;
  }
  try {
    const msg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!msg.ok) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
    }
    log('TG 文本已发送');
  } catch (e) {
    log(`TG 发送异常 (非致命): ${e.message}`);
  }

  if (photo) {
    await sendTgPhoto(chat, token, photo);
  }
}

function formatTgMessage({ failed, results = [], errorMsg = '' }) {
  const beijingTime = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const hasRenewed = results.some((r) => r.ok && !r.skip);
  const allSkipped = results.length > 0 && results.every((r) => r.ok && r.skip);

  let title = '✅ <b>【ACLClouds 自动续期成功】</b>';
  let badge = '🎉 服务续期成功';
  if (failed) {
    title = '❌ <b>【ACLClouds 自动续期失败】</b>';
    badge = '⚠️ 续期任务异常';
  } else if (allSkipped) {
    title = '⏳ <b>【ACLClouds 续期检查 - 未到窗口】</b>';
    badge = 'ℹ️ 暂未到可续期时间';
  }

  const lines = [
    title,
    '━━━━━━━━━━━━━━━━━━━━',
    `🕒 <b>执行时间</b>: ${beijingTime} (北京时间)`,
    `👤 <b>当前账号</b>: <code>${USER || '未设置'}</code>`,
    `📊 <b>任务状态</b>: ${badge}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '<b>服务详情</b>:',
  ];

  if (failed && errorMsg) {
    lines.push(`• 异常原因: ${errorMsg}`);
  }

  for (const r of results) {
    const icon = r.ok ? (r.skip ? '⏳' : '✅') : '❌';
    lines.push(`• ${icon} ${r.text}`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  if (failed) {
    lines.push('⚠️ 请及时查看 GitHub Actions 运行日志与失败截图排查。');
  } else if (hasRenewed) {
    lines.push('✨ 服务已成功延期，将在下次预定周期继续自动守护。');
  } else {
    lines.push('📌 站点限制到期前 2 天方可续期，下次执行将自动处理。');
  }

  return lines.join('\n');
}

async function ocrPick(dir, prompt, n) {
  const worker = await Tesseract.createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: '7',
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  });
  const results = [];
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `${i}.png`);
    const r = await worker.recognize(file);
    const text = (r.data.text || '').replace(/\s+/g, '').trim();
    const best = VOCAB.map((v) => ({ v, s: score(text, v) })).sort((p, q) => q.s - p.s)[0];
    results.push({ i, text, guess: best.v, vsPrompt: ocrScore(text, best.v, prompt) });
  }
  await worker.terminate();
  results.sort((a, b) => b.vsPrompt - a.vsPrompt);
  log(`OCR prompt=${prompt} ${results.map((x) => `${x.i}:${x.text || x.guess}(${x.vsPrompt})`).join(' ')}`);
  if (!results[0] || results[0].vsPrompt < 75) throw new Error(`OCR 未匹配 ${prompt}: ${JSON.stringify(results)}`);
  return results[0].i;
}

async function solveCaptcha(page, prefix = '') {
  const root = prefix ? `${prefix} ` : '';
  const checkbox = page.locator(`${root}div[role='checkbox']`).first();
  await checkbox.click();
  await page.waitForSelector(`${root}.auth-captcha-option-img`, { timeout: 20000 });
  await page.waitForFunction(
    (sel) => {
      const imgs = [...document.querySelectorAll(sel)];
      return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0 && i.clientHeight > 0);
    },
    `${root}.auth-captcha-option-img`,
    { timeout: 20000 }
  );

  const promptRaw = await page.locator(`${root}.auth-captcha-prompt`).innerText();
  const prompt = promptRaw.replace(/^(?:Click on|Cliquez sur)\s+/i, '').trim();
  const imgs = page.locator(`${root}.auth-captcha-option-img`);
  const n = await imgs.count();
  const dir = path.join(SHOT, 'captcha');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const src = await imgs.nth(i).getAttribute('src');
    const url = src.startsWith('http') ? src : BASE + src;
    const bytes = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, url);
    fs.writeFileSync(path.join(dir, `${i}.png`), Buffer.from(bytes));
  }
  await shot(page, '02-captcha.png');
  const pick = await ocrPick(dir, prompt, n);
  await page.locator(`${root}.auth-captcha-option`).nth(pick).evaluate((el) => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true',
    `${root}div[role='checkbox']`,
    { timeout: 15000 }
  );
  log(`验证码通过: ${prompt} -> option ${pick + 1}`);
}

async function solveCaptchaApi(page, context = 'renewal_gate') {
  log(`通过 API 求解验证码 (context: ${context})...`);
  const challengeRes = await api(page, `/auth/captcha/challenge?context=${encodeURIComponent(context)}`);
  if (challengeRes.status !== 200 || !challengeRes.data?.id) {
    throw new Error(`获取验证码 challenge 失败: HTTP ${challengeRes.status}`);
  }
  const chal = challengeRes.data;
  await page.waitForTimeout(1200);

  const initialVerify = await api(page, '/auth/captcha', 'POST', {
    context: chal.context || context,
    id: chal.id,
    ts: chal.ts,
    sig: chal.sig,
    elapsed: 1400,
  });

  if (initialVerify.status !== 200) {
    throw new Error(`验证码初始验证失败: HTTP ${initialVerify.status}`);
  }

  const ver = initialVerify.data;
  if (ver.passed && ver.token) {
    log('验证码无感直通成功');
    return ver.token;
  }

  if (!ver.interactive || !ver.target || !Array.isArray(ver.options)) {
    throw new Error(`验证码返回非交互态: ${JSON.stringify(ver)}`);
  }

  const target = ver.target;
  const options = ver.options;
  const dir = path.join(SHOT, 'captcha_api');
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < options.length; i++) {
    const imgUrl = `${BASE}/auth/captcha/image?t=${encodeURIComponent(options[i])}`;
    const bytes = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, imgUrl);
    fs.writeFileSync(path.join(dir, `${i}.png`), Buffer.from(bytes));
  }

  const pick = await ocrPick(dir, target, options.length);
  const selectedOption = options[pick];

  const submitVerify = await api(page, '/auth/captcha', 'POST', {
    context: ver.context || context,
    id: ver.id,
    ts: ver.ts,
    sig: ver.sig,
    answer: selectedOption,
    answer_sig: ver.answer_sig || '',
    target: target,
  });

  if (submitVerify.status === 200 && submitVerify.data?.passed && submitVerify.data?.token) {
    log(`API 验证码成功解决: ${target} -> token 获得`);
    return submitVerify.data.token;
  }
  throw new Error(`API 验证码选项提交未通过: ${JSON.stringify(submitVerify.data)}`);
}

async function api(page, p, method = 'GET', body) {
  return page.evaluate(async ({ p, method, body }) => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const res = await fetch(p, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 400); }
    return { status: res.status, data };
  }, { p, method, body });
}

async function loggedIn(page) {
  if (/\/dashboard/i.test(page.url())) return true;
  const r = await api(page, '/api/client/account');
  return r.status === 200 && r.data?.object === 'user';
}

async function login(page) {
  log(`登录 ${BASE} as ${USER}`);
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
  if (await loggedIn(page)) {
    log('已有会话,跳过验证码');
    return;
  }
  if (fs.existsSync(AUTH)) {
    log('会话失效,重新登录');
    fs.unlinkSync(AUTH);
  }
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await shot(page, '01-login.png');
  let authed = false;
  for (let i = 0; i < 4 && !authed; i++) {
    try {
      await solveCaptcha(page);
      authed = true;
    } catch (e) {
      log(`验证码失败(${i + 1}/4): ${e.message}`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.fill('#username', USER);
      await page.fill('#password', PASS);
    }
  }
  if (!authed) throw new Error('验证码多次失败');
  await page.click("button[type='submit']");
  await page.waitForURL(/\/dashboard/, { timeout: 25000 });
  await page.context().storageState({ path: AUTH });
  log(`登录成功,会话写入 ${AUTH}`);
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  const diff = target - Date.now();
  if (isNaN(diff)) return null;
  if (diff <= 0) return '已到期';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const expStr = new Date(target).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${d}天${h}小时 (到期: ${expStr})`;
}

async function discover(page) {
  const servers = [];
  const r = await api(page, '/api/client');
  if (r.status === 200 && Array.isArray(r.data?.data)) {
    for (const item of r.data.data) {
      if (item.object === 'server' && item.attributes) {
        servers.push({
          id: item.attributes.identifier,
          uuid: item.attributes.uuid,
          name: item.attributes.name || item.attributes.identifier,
          expiresAt: item.attributes.expires_at || null,
          canRenew: !!item.attributes.can_renew,
        });
      }
    }
  }

  if (SERVER_ID && !servers.some((s) => s.id === SERVER_ID || s.uuid === SERVER_ID)) {
    servers.push({ id: SERVER_ID, uuid: SERVER_ID, name: SERVER_ID, expiresAt: null, canRenew: false });
  }

  log(`发现服务: ${servers.map((s) => `${s.name}(${s.id}) 到期:${s.expiresAt || '未知'}`).join(', ') || '(无)'}`);
  return servers;
}

function classifyRenew(r) {
  if (r.status === 200) {
    const exp = r.data?.expires_at ? ` (到期: ${r.data.expires_at})` : '';
    return { ok: true, skip: false, captcha: false, text: `续期成功${exp} ${r.data?.message || JSON.stringify(r.data).slice(0, 120)}` };
  }
  if (r.status === 400 && (r.data?.error === 'renewal_not_available' || r.data?.code === 'renewal_not_available')) {
    return { ok: true, skip: true, captcha: false, text: `未到续期窗口 剩余 ${r.data.days_remaining ?? r.data.hours_remaining ?? '?'} 天/小时` };
  }
  const blob = JSON.stringify(r.data);
  if (r.status === 403 && /captcha_required/i.test(blob)) {
    return { ok: false, skip: false, captcha: true, text: 'HTTP 403 captcha_required' };
  }
  return { ok: false, skip: false, captcha: false, text: `HTTP ${r.status} ${blob.slice(0, 180)}` };
}

async function tryRenew(page, server) {
  const id = server.id;
  const name = server.name || id;
  log(`开始检查续期: ${name} (${id})`);

  if (DRY_RUN) return { id, ok: true, skip: true, text: `[DRY_RUN] ${name} (${id}) 跳过实际提交` };

  // 1. UI 自动化续期
  await page.goto(`${BASE}/dashboard/projects`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);

  const renewBtn = page.locator('button:has-text("Renouveler"), button:has-text("Renew")').first();
  const hasBtn = (await renewBtn.count()) > 0;

  if (hasBtn) {
    log(`找到 UI 续期按钮,执行点击...`);
    await renewBtn.click();
    await page.waitForTimeout(2000);

    const modal = page.locator("[role='dialog']");
    if ((await modal.count()) > 0) {
      log('检测到防机器人人机验证弹窗,开始过盾...');
      try {
        await solveCaptcha(page, "[role='dialog']");
        await page.waitForTimeout(4000);
      } catch (e) {
        log(`弹窗验证码处理异常: ${e.message}`);
      }
    }

    // 验证 UI 结果
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (/Expire dans\s+[2-9]j/i.test(bodyText) || /renouvellement sera disponible/i.test(bodyText)) {
      const match = bodyText.match(/Expire dans\s+([0-9]+j(?:\s+[0-9]+h)?)/i);
      const exp = match ? `剩余 ${match[1]}` : '成功延期';
      log(`UI 续期验证成功: ${exp}`);
      return { id, ok: true, skip: false, text: `${name} (${id}): 续期成功 (${exp})` };
    }
  }

  // 2. API 直接续期及验证码补发
  log(`尝试 API 续期接口...`);
  const renewPath = `/api/client/servers/${id}/upgrade/renew`;
  let r = await api(page, renewPath, 'POST', {});
  let c = classifyRenew(r);

  if (c.captcha) {
    log(`检测到 captcha_required,获取 renewal_gate 验证码凭据...`);
    try {
      const token = await solveCaptchaApi(page, 'renewal_gate');
      r = await api(page, renewPath, 'POST', { captcha_token: token });
      c = classifyRenew(r);
    } catch (e) {
      c = { ok: false, skip: false, captcha: false, text: `验证码求解失败: ${e.message}` };
    }
  }

  let resultText = `${name} (${id}): ${c.text}`;
  const exactRemaining = formatRemaining(server.expiresAt);
  if (c.skip && exactRemaining) {
    resultText = `${name} (${id}): 未到续期窗口，剩余 ${exactRemaining}`;
  }

  log(`API 续期结果: ${resultText}`);
  return { id, ok: c.ok, skip: c.skip, text: resultText };
}

function resolveExecutablePath() {
  const paths = [
    process.env.CHROME_PATH,
    'D:\\PlaywrightBrowsers\\chromium-1217\\chrome-win64\\chrome.exe',
  ].filter(Boolean);
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function main() {
  if (!USER || !PASS) throw new Error('缺少 ACL_USERNAME / ACL_PASSWORD');
  const execPath = resolveExecutablePath();
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(execPath ? { executablePath: execPath } : {}),
  };
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: fs.existsSync(AUTH) ? AUTH : undefined,
  });
  const page = await context.newPage();
  let summary = '';
  let failed = false;
  const results = [];
  try {
    await login(page);
    await shot(page, '03-dashboard.png');

    const servers = await discover(page);
    await shot(page, '04-projects.png');

    for (const server of servers) {
      const res = await tryRenew(page, server);
      results.push(res);
    }

    if (!results.length) {
      failed = true;
      summary = '未找到可续期服务';
    } else {
      summary = results.map((r) => r.text).join('\n');
      failed = results.some((r) => !r.ok);
    }

    const hasRenewed = results.some((r) => r.ok && !r.skip);
    if (hasRenewed) {
      await shot(page, '06-result.png');
    }
  } catch (e) {
    failed = true;
    summary = `执行失败: ${e.message}`;
    log(summary);
    try { await shot(page, '99-error.png'); } catch {}
  } finally {
    await browser.close().catch(() => {});
  }
  log(summary);

  // 截图仅限续期完成和执行失败
  let photoToSend = null;
  if (failed) {
    const errPic = path.join(SHOT, '99-error.png');
    if (fs.existsSync(errPic)) photoToSend = errPic;
  } else if (results.some((r) => r.ok && !r.skip)) {
    const donePic = path.join(SHOT, '06-result.png');
    if (fs.existsSync(donePic)) photoToSend = donePic;
  }

  const tgMessage = formatTgMessage({
    failed,
    results,
    errorMsg: failed && !results.length ? summary : '',
  });

  await tg(tgMessage, { photo: photoToSend });
  if (failed) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (e) => {
    log(e.stack || e.message);
    const failPic = path.join(SHOT, '99-error.png');
    const tgMessage = formatTgMessage({
      failed: true,
      results: [],
      errorMsg: e.message,
    });
    await tg(tgMessage, { photo: fs.existsSync(failPic) ? failPic : null });
    process.exit(1);
  });
}

export { score, ocrScore, classifyRenew };
