#!/usr/bin/env node
import { chromium } from 'playwright';
import Tesseract from 'tesseract.js';
import fs from 'fs';
import path from 'path';

const BASE = (process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(/\/+$/, '');
const USER = process.env.ACL_USERNAME || process.env.ACL_EMAIL || '';
const PASS = process.env.ACL_PASSWORD || '';
const SERVER_ID = process.env.ACL_SERVER_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const SHOT = path.resolve('shots');
const VOCAB = ['Panel', 'VPS', 'Bot', 'Serveur', 'Cloud', 'ACLClouds', 'Minecraft', 'Discord', 'Housing', 'Tunnel', 'Dedicated', 'Free', 'Upgrade', 'Renew'];

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

async function shot(page, name) {
  const p = path.join(SHOT, name);
  await page.screenshot({ path: p, fullPage: true });
  shots.push(p);
  log(`截图 ${name}`);
  return p;
}

async function tg(text, { photos = false } = {}) {
  const token = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (!token || !chat) {
    log('未配置 TG_BOT_TOKEN/TG_CHAT_ID,跳过通知');
    return;
  }
  const msg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!msg.ok) log(`TG 文本失败: ${await msg.text()}`);
  else log('TG 文本已发送');
  if (!photos) return;
  let n = 0;
  for (const photo of shots) {
    const base = path.basename(photo);
    if (/^(01-login|02-captcha)\.png$/i.test(base) || photo.includes(`${path.sep}captcha${path.sep}`)) continue;
    if (!fs.existsSync(photo) || fs.statSync(photo).size < 100) continue;
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('photo', new Blob([fs.readFileSync(photo)], { type: 'image/png' }), path.basename(photo));
    form.append('caption', path.basename(photo));
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!r.ok) log(`TG 图片失败 ${path.basename(photo)}: ${await r.text()}`);
    else n++;
  }
  log(`TG 截图 ${n} 张`);
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
    results.push({ i, text, guess: best.v, vsPrompt: score(text, prompt) || score(best.v, prompt) });
  }
  await worker.terminate();
  results.sort((a, b) => b.vsPrompt - a.vsPrompt);
  log(`OCR prompt=${prompt} ${results.map((x) => `${x.i}:${x.text || x.guess}(${x.vsPrompt})`).join(' ')}`);
  if (!results[0] || results[0].vsPrompt < 80) throw new Error(`OCR 未匹配 ${prompt}: ${JSON.stringify(results)}`);
  return results[0].i;
}

async function solveCaptcha(page) {
  await page.locator("div[role='checkbox']").click();
  await page.waitForSelector('.auth-captcha-option-img', { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.auth-captcha-option-img')].every((i) => i.naturalWidth > 0 && i.clientHeight > 0));
  const promptRaw = await page.locator('.auth-captcha-prompt').innerText();
  const prompt = promptRaw.replace(/^Click on\s+/i, '').trim();
  const imgs = page.locator('.auth-captcha-option-img');
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
  await page.locator('.auth-captcha-option').nth(pick).evaluate((el) => el.click());
  await page.waitForFunction(() => document.querySelector("[role='checkbox']")?.getAttribute('aria-checked') === 'true', { timeout: 15000 });
  log(`验证码通过: ${prompt} -> option ${pick + 1}`);
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

function collectIds(obj, out = new Set()) {
  if (!obj) return out;
  if (Array.isArray(obj)) { obj.forEach((x) => collectIds(x, out)); return out; }
  if (typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^[a-z0-9-]{6,40}$/i.test(v) && /id|uuid|identifier/i.test(k)) out.add(v);
    else if (v && typeof v === 'object') collectIds(v, out);
  }
  return out;
}

async function discover(page) {
  const ids = new Set();
  if (SERVER_ID) ids.add(SERVER_ID);
  const pages = [
    `${BASE}/dashboard`,
    `${BASE}/dashboard/projects?type=discord`,
    `${BASE}/dashboard/projects`,
    `${BASE}/dashboard/billing/subscriptions`,
  ];
  if (SERVER_ID) pages.push(`${BASE}/server/${SERVER_ID}`);
  const hrefs = [];
  for (const url of pages) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    const found = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href));
    hrefs.push(...found);
  }
  for (const h of hrefs) {
    const m = h.match(/\/(?:server|servers|project|projects|subscription|subscriptions)\/([a-z0-9-]{6,40})/i);
    if (m) ids.add(m[1]);
  }
  const listPaths = [
    '/api/client',
    '/api/client/servers',
    '/api/client/credits/subscriptions',
    '/api/client/account',
  ];
  const dumps = [];
  for (const p of listPaths) {
    const r = await api(page, p);
    dumps.push({ p, status: r.status, keys: r.data && typeof r.data === 'object' ? Object.keys(r.data).slice(0, 12) : String(r.data).slice(0, 80) });
    collectIds(r.data, ids);
    const arr = r.data?.data || r.data?.servers || r.data?.subscriptions || [];
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (s?.id) ids.add(String(s.id));
        if (s?.attributes?.identifier) ids.add(s.attributes.identifier);
        if (s?.attributes?.uuid) ids.add(s.attributes.uuid);
      }
    }
  }
  log(`发现 ID: ${[...ids].join(', ') || '(无)'} dump=${JSON.stringify(dumps)}`);
  return [...ids];
}

function classifyRenew(r) {
  if (r.status === 200) return { ok: true, skip: false, text: `续期成功 ${JSON.stringify(r.data).slice(0, 180)}` };
  if (r.status === 400 && (r.data?.error === 'renewal_not_available' || r.data?.code === 'renewal_not_available')) {
    return { ok: true, skip: true, text: `未到续期窗口 剩余 ${r.data.days_remaining ?? r.data.hours_remaining ?? '?'} 天/小时` };
  }
  return { ok: false, skip: false, text: `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 180)}` };
}

async function main() {
  if (!USER || !PASS) throw new Error('缺少 ACL_USERNAME / ACL_PASSWORD');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let summary = '';
  let failed = false;
  try {
    log(`登录 ${BASE} as ${USER}`);
    await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
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
    await shot(page, '03-dashboard.png');
    log('登录成功');

    const ids = await discover(page);
    await page.goto(`${BASE}/dashboard/projects?type=discord`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await shot(page, '04-projects.png');
    const btn = page.getByRole('button', { name: /renouvel|renew|续期/i }).first();
    const link = page.getByRole('link', { name: /renouvel|renew|续期/i }).first();
    if (await btn.count()) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(1500);
      await shot(page, '05-renew-click.png');
    } else if (await link.count()) {
      await link.click().catch(() => {});
      await page.waitForTimeout(1500);
      await shot(page, '05-renew-click.png');
    }

    const pathsFor = (id) => [
      `/api/client/servers/${id}/upgrade/renew`,
      `/api/client/servers/${id}/renew`,
      `/api/client/account/servers/${id}/renew`,
    ];
    let best = null;
    for (const id of ids) {
      const exists = await api(page, `/api/client/servers/${id}`);
      log(`GET /api/client/servers/${id} -> ${exists.status}`);
      if (exists.status === 404) continue;
      if (DRY_RUN) { best = { id, text: `DRY_RUN ${id} GET ${exists.status}` }; break; }
      for (const p of pathsFor(id)) {
        const r = await api(page, p, 'POST', {});
        const c = classifyRenew(r);
        log(`POST ${p} -> ${c.text}`);
        if (c.ok) { best = { id, text: `${id} ${c.text}` }; break; }
        if (!best) best = { id, text: `${id} ${c.text}` };
      }
      if (best && !String(best.text).includes('失败') && !String(best.text).includes('HTTP 404')) break;
    }
    await shot(page, '06-result.png');
    if (!best) {
      failed = true;
      summary = `未找到可续期服务 ids=${ids.join(',') || '空'}`;
    } else {
      summary = best.text;
      failed = /失败|HTTP 401|HTTP 403|HTTP 404|HTTP 5/.test(summary) && !/未到续期窗口|续期成功|DRY_RUN/.test(summary);
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
  const skipped = /未到续期窗口/.test(summary);
  await tg(`${failed ? '❌' : skipped ? '⏳' : '✅'} ACLClouds 续期\n${summary}`, { photos: failed });
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  log(e.stack || e.message);
  await tg(`❌ ACLClouds 续期崩溃\n${e.message}`, { photos: true });
  process.exit(1);
});
