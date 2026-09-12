# ACLClouds Auto-Renew

ACLClouds Free Bot 托管自动续期。Free 套餐约 4 天到期，到期前 1 天才开放续期。脚本用账号密码登录（OCR 过站点自定义验证码），发现真实 server id，调用续期 API。GitHub Actions 每天跑一次，结果发 Telegram。

## 做什么

1. Playwright 打开 `/auth/login`，填 `ACL_USERNAME` / `ACL_PASSWORD`
2. 点「I am not a robot」，四选一词图用 tesseract.js 对 prompt 识别后点击
3. 登录进 dashboard，扫页面链接 + `/api/client` / `/api/client/credits/subscriptions` 找 server id
4. `POST /api/client/servers/{id}/upgrade/renew`
   - `200` 续期成功
   - `400 renewal_not_available` 未到窗口（按成功处理）
   - 其它状态当失败
5. Telegram 通知（见下）

实测：账号 `aclbot_638370` 的真实 server id 是 `da9333c4`（不是面板 URL 里的 `5c0ab2ab`）。

## Telegram

| 结果 | 发什么 |
|---|---|
| 续期成功 | 一条最终状态，不带图 |
| 未到续期窗口 | 一条最终状态（剩余天数），不带图 |
| 续期失败 / 崩溃 | 最终状态 + 续期相关截图 |

登录、验证码过程不发 TG。本地仍会把全过程截图写到 `shots/`。

## GitHub Actions

`.github/workflows/renew.yml`：每天 UTC `03:17`，也可手动 Run workflow。

Secrets：

| 名 | 用途 |
|---|---|
| `ACL_USERNAME` | 登录用户名 |
| `ACL_PASSWORD` | 密码 |
| `ACL_SERVER_ID` | 可选，已知 server id（如 `da9333c4`）；留空则自动发现 |
| `TG_BOT_TOKEN` | Telegram bot token |
| `TG_CHAT_ID` | Telegram chat id |

Variable（可选）：`ACL_BASE_URL`，默认 `https://aclclouds.com`

## 本地跑

```bash
cp .env.example .env   # 填账号、TG
npm install
npx playwright install chromium
node with-env.cjs
```

`DRY_RUN=1` 只登录和发现服务，不 POST renew。

## 已完成 / 待做

**已完成**

- 账号密码登录，不再依赖手动导出 session cookie
- 站点自定义验证码（Click on Panel/Bot/Discord…）OCR 可过，workflow 已实测
- 自动发现真实 Pterodactyl server id（`da9333c4`），并跳过面板短 id `5c0ab2ab` 的 404
- 续期接口打通；窗口外返回 `renewal_not_available` 视为正常
- Actions 定时 + Secrets / Variable
- TG：成功或未到窗口只发最终续期状态；失败才发续期/报错截图。登录和验证码不通知

**待做**

- 等窗口打开（最近一次还剩 1 天）再打一次，确认 `200` 后续期天数真的往后推
- 续期接口若回 `403 captcha_required`，目前当失败；需要的话再过一次验证码后重试
- 多台机器：现在发现多个 id 后停在第一个可调用的
- 登录后把 session cookie 存下来，下次跳过验证码
- OCR 认空/认错会换题重试最多 4 次，极端扭曲图仍可能卡死
