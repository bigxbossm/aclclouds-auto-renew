# ACLClouds 自动续期

自动续期 [ACLClouds](https://aclclouds.com) 免费 Bot 托管服务(Free 套餐:315MB RAM,每 4 天需手动续期,到期壀 1 天开放续期按钮)。

## 原理

逆向自站点前端(webpack chunk `1459.js`):

```
POST /api/client/servers/{server_id}/upgrade/renew
Header: X-XSRF-TOKEN: <XSRF-TOKEN cookie 的 URL 解码值>
Cookie: __Host-aclclouds_session=...; XSRF-TOKEN=...
```

| HTTP | 含义 |
|------|------|
| 200 | 续期成功 |
| 400 `renewal_not_available` + `days_remaining` | 未到续期窗口(到期前 1 天开放) |
| 403 `captcha_required` | 站点风控要求人机验证,需浏览器处理 |
| 401 / 419 | 会话失效 / CSRF 过期(脚本会自动刷新重试一次) |

## 使用

### 方式 A:GitHub Actions 全自动(推荐)

1. Fork 或使用本仓库,在 **Settings → Secrets and variables → Actions** 添加 secrets:

   | Secret | 说明 |
   |--------|------|
   | `ACL_SESSION` | **必填**。浏览器登录 ACLClouds 后,F12 → Application → Cookies → 复制 `__Host-aclclouds_session` 的值 |
   | `ACL_REMEMBER` | 可选。`remember_web_59ba36…` cookie 值,可显著延长会话有效期 |
   | `ACL_SERVER_ID` | 可选。指定单个服务器 ID(如 `5c0ab2ab`);留空则自动续期账号下所有 Free 服务 |
   | `ACL_EMAIL` / `ACL_PASSWORD` | 可选。邮箱密码登录(实验性,不保证通过) |

2. 手动触发一次验证:Actions → ACLClouds Auto Renew → **Run workflow**
3. 之后每 4 小时自动运行,到续期窗口自动续上。

> 会话有效期有限(HttpOnly cookie)。`ACL_REMEMBER` + 定期重新导出可保长期稳定;脚本报 401 时需更新 `ACL_SESSION` secret。

### 方式 B:本地运行

```bash
export ACL_SESSION='<__Host-aclclouds_session 的值>'
export ACL_REMEMBER='<remember_web_... 的值>'   # 可逊
node renew.mjs

# 只看状态不续期
DRY_RUN=1 node renew.mjs
```

## 输出示例

```
[2026-09-14T08:00:00Z] 目标: https://aclclouds.com (自动发现)
[2026-09-14T08:00:00Z] 发现 1 个服务: Mon bot(5c0ab2ab, 到期 2026-09-15T04:50:19+02:00)
[2026-09-14T08:00:01Z] 续期 Mon bot (5c0ab2ab) …
[2026-09-14T08:00:01Z] ⏳ 未到续期窗口(还剩 1 天),下次运行再试
[2026-09-14T08:00:01Z] 完成: 成功 0,未到窗口 1,失败 0
```

## 注意

- 本项目仅用于自动化自己账号的免费套餐续期,请勿滥用。
- 密码/Cookie 只放 GitHub Secrets 或本地环境变量,**不要提交到仓库**。
