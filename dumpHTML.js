const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

chromium.use(StealthPlugin());

async function run() {
  const account = require('./accounts.json')[0];
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
  await page.waitForTimeout(3000);
  
  const dialogSelectors = [
    '[role="dialog"]',
    'div[class] > div[class] > div[class]:has(> div[aria-label="Close"])',
  ];

  let dialog = null;
  for (const sel of dialogSelectors) {
    dialog = await page.$(sel);
    if (dialog) {
      console.log('Dialog found: ' + sel);
      break;
    }
  }
  
  if (dialog) {
    const likes = await dialog.$$eval('[role="button"], [aria-label]', els => 
      els.filter(e => {
        const lbl = e.getAttribute('aria-label');
        return lbl && (lbl.includes('Like') || lbl.includes('أعجبني'));
      }).map(e => ({
        label: e.getAttribute('aria-label'),
        html: e.outerHTML,
        inUl: !!e.closest('ul')
      }))
    );
    console.log('Likes found: ', JSON.stringify(likes, null, 2));
    
    const reactionBtn = await dialog.$eval('[data-ad-rendering-role="like_button"]', el => el.outerHTML).catch(() => 'No data-ad-rendering-role found.');
    console.log('Reaction btn rendering role:', reactionBtn);
  } else {
    console.log('No dialog found');
  }

  await browser.close();
}

run().catch(console.error);
