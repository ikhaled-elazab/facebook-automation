'use strict';

/**
 * vision.js — AI Vision Action Loop
 *
 * When all hardcoded selector retries are exhausted, aiAct() takes a viewport
 * screenshot, sends it to GPT-4o (vision), parses the returned JSON action,
 * executes it via Playwright, and repeats until the goal is achieved or the
 * step budget runs out.
 *
 * Exports: { aiAct(page, goal, account) → Promise<boolean> }
 */

const config = require('./config.json');
const logger = require('./logger.js');

let openaiClient = null;

function getClient() {
  if (openaiClient) return openaiClient;
  try {
    const { OpenAI } = require('openai');
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
    return openaiClient;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are a browser automation assistant. You receive screenshots of a Facebook page and must decide the next action to achieve a given goal.

Respond with JSON only — no markdown fences, no explanation outside the JSON object.

Valid actions:
- {"action":"click","x":<int>,"y":<int>,"reason":"..."}
- {"action":"type","text":"<string>","reason":"..."}
- {"action":"scroll","direction":"down"|"up","amount":<pixels>,"reason":"..."}
- {"action":"press","key":"<key>","reason":"..."}
- {"action":"done","reason":"..."}
- {"action":"failed","reason":"..."}

Rules:
- Coordinates must be integers within viewport bounds (x: 1–1365, y: 1–767).
- If the goal is already achieved, return {"action":"done","reason":"..."}.
- Never click Unlike on a post that already shows Unlike — it is already liked, return done.
- If the goal cannot be achieved, return {"action":"failed","reason":"..."}.`;

/**
 * Execute one AI-decided action on the page.
 * Returns true if the loop should stop (done/failed/budget exhausted).
 */
async function executeAction(page, action) {
  switch (action.action) {
    case 'click': {
      const x = Math.max(1, Math.min(1365, Math.round(action.x)));
      const y = Math.max(1, Math.min(767, Math.round(action.y)));
      await page.mouse.click(x, y);
      break;
    }
    case 'type':
      await page.keyboard.type(String(action.text || ''), { delay: 60 });
      break;
    case 'scroll': {
      const dy = action.direction === 'up'
        ? -Math.abs(action.amount || 300)
        : Math.abs(action.amount || 300);
      await page.evaluate((scrollDy) => window.scrollBy(0, scrollDy), dy);
      break;
    }
    case 'press':
      await page.keyboard.press(String(action.key || 'Enter'));
      break;
    case 'done':
    case 'failed':
      return true; // signal loop to stop
    default:
      break;
  }
  return false;
}

/**
 * Main export. Drives the page toward `goal` using GPT-4o vision.
 * Returns true on success, false on failure or budget exhaustion.
 */
async function aiAct(page, goal, account) {
  const client = getClient();
  if (!client) {
    logger.warn(account.name, 'VISION', 'OpenAI client unavailable — vision fallback skipped.');
    return false;
  }

  const maxSteps = config.visionMaxSteps || 8;
  const model = config.visionModel || 'gpt-4o';

  for (let step = 1; step <= maxSteps; step++) {
    // 1. Capture viewport screenshot
    let screenshotBase64;
    try {
      const buf = await page.screenshot({ fullPage: false });
      screenshotBase64 = buf.toString('base64');
    } catch (err) {
      logger.warn(account.name, 'VISION', `Screenshot failed at step ${step}: ${err.message}`);
      return false;
    }

    // 2. Ask GPT-4o
    let raw;
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 200,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Step ${step}/${maxSteps}. Goal: ${goal}`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${screenshotBase64}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
      });
      raw = response.choices[0]?.message?.content?.trim() || '';
    } catch (err) {
      logger.warn(account.name, 'VISION', `GPT-4o call failed at step ${step}: ${err.message}`);
      return false;
    }

    // 3. Parse JSON action
    let action;
    try {
      action = JSON.parse(raw);
    } catch {
      logger.warn(account.name, 'VISION', `Step ${step}: could not parse JSON: ${raw.slice(0, 120)}`);
      return false;
    }

    logger.log(
      account.name,
      'VISION',
      `Step ${step}/${maxSteps}: action="${action.action}" | reason="${action.reason || ''}"`
    );

    // 4. Execute action
    if (action.action === 'done') return true;
    if (action.action === 'failed') return false;

    const stop = await executeAction(page, action);
    if (stop) return action.action === 'done';

    // 5. Wait for React re-render
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  logger.warn(account.name, 'VISION', `Step budget (${maxSteps}) exhausted without reaching goal.`);
  return false;
}

module.exports = { aiAct };
