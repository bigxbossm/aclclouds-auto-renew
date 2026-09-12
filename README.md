# ACLClouds Auto-Renew

用账号密码登录 ACLClouds，OCR 过自定义验证码，调用续期 API。GitHub Actions 每天跑一次，结果带截图发 Telegram。

Secrets：`ACL_USERNAME` `ACL_PASSWORD` `ACL_SERVER_ID` `TG_BOT_TOKEN` `TG_CHAT_ID`  
Variable（可选）：`ACL_BASE_URL`

本地：

```bash
cp .env.example .env
npm install
npx playwright install chromium
node with-env.cjs
```
