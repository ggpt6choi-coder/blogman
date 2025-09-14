require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { logWithTime } = require('./common');
const { exec } = require('child_process');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'ko-KR',
  });

  const page = await context.newPage();

  await page.goto('https://partners.coupang.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.click(
    '#app-header > div.header-toolbar > div > button:nth-child(1)'
  );

  await page.waitForSelector('#login-email-input', { timeout: 10000 });
  await page.fill('#login-email-input', process.env.COUPANG_ID);
  await page.fill(
    '#login-password-input',
    process.env.COUPANG_PW.replace(/"/g, '')
  );
  await page.click(
    '#memberLogin > div.tab-item.member-login._loginRoot.sms-login-target.style-v2 > form > div.login__content.login__content--trigger > button'
  );
})();
