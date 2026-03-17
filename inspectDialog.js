const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

chromium.use(StealthPlugin());

async function run() {
  const accounts = require('./accounts.json');
  const account = accounts[0];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: path.resolve(account.sessionFile),
    userAgent: account.userAgent,
    viewport: { width: 1366, height: 768 },
    locale: account.locale
  });
  const page = await context.newPage();
  
  const url = 'https://www.facebook.com/permalink.php?story_fbid=104071832072840&id=100079679291285';
  console.log('Navigating to: ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000); // Wait for modal to render
  
  const data = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Close"]');
    if (!btn) return 'No close btn';
    let p = btn.parentElement;
    let chain = [];
    while(p && p !== document.body && chain.length < 15) {
      chain.push({
        tag: p.tagName,
        className: p.className,
        role: p.getAttribute('role'),
        hasArticle: !!p.querySelector('[role="article"]'),
        hasLike: !!p.querySelector('[aria-label="Like"]')
      });
      p = p.parentElement;
    }
    return chain;
  });
  
  console.log('Chain: \n', JSON.stringify(data, null, 2));
  await browser.close();
}

run().catch(console.error);
