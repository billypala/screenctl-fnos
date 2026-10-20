'use strict';
// UI 截图验证：默认态 + 两个开关点亮的形态
const path = require('node:path');
const { chromium } = require(process.env.PW_PATH || 'playwright-core');

const BASE = 'http://127.0.0.1:5092';
const OUT = path.join(__dirname, '..', 'assets');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 800 } });

  // 1. 默认态（屏幕开=亮、合盖=关）
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'ui-1-default.png') });

  // 2. 点击合盖按钮 → 点亮态
  await page.click('#btnLid');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'ui-2-lid-on.png') });

  // 3. 点灭屏幕按钮 + 移动端窄屏
  await page.click('#btnScreen');
  await page.waitForTimeout(700);
  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'ui-3-mobile.png') });

  // 4. 网关前缀路径回退
  await page.setViewportSize({ width: 480, height: 800 });
  const resp = await page.goto(BASE + '/app/screenctl', { waitUntil: 'networkidle' });
  console.log('gateway-prefix path status:', resp.status());
  const hasCard = await page.$('.card');
  console.log('card rendered:', !!hasCard);

  // 5. 重启确认框存在性
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  page.once('dialog', (d) => {
    console.log('reboot confirm dialog:', d.message().slice(0, 20));
    d.dismiss();
  });
  await page.click('#btnReboot');
  await page.waitForTimeout(300);

  await browser.close();
  console.log('DONE');
})().catch((e) => { console.error(e); process.exit(1); });
