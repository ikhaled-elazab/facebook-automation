'use strict';

require('dotenv').config();

const config = require('./config.json');

// Secret is read from the environment (.env → process.env), NOT config.json.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

let openaiClient = null;

function getClient() {
  if (openaiClient) return openaiClient;
  try {
    const { OpenAI } = require('openai');
    openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
    return openaiClient;
  } catch {
    return null;
  }
}

function pickRandom(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function isAIEnabled() {
  return config.useAI === true && OPENAI_API_KEY.trim().length > 0;
}

async function generateComment(postText, account) {
  if (!isAIEnabled()) return pickRandom(account.comments);

  try {
    const client = getClient();
    if (!client) return pickRandom(account.comments);

    const truncated = (postText || '').slice(0, 500);
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 60,
      temperature: 0.85,
      messages: [
        {
          role: 'system',
          content: 'You write short, natural-sounding Facebook comments in response to posts. Be genuine, brief (1-2 sentences), and avoid hashtags or emojis unless they fit naturally.',
        },
        {
          role: 'user',
          content: `Write a comment for this Facebook post:\n\n${truncated}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (text) return text;
  } catch {
    // fall through to random
  }

  return pickRandom(account.comments);
}

async function generateReply(commentText, account) {
  if (!isAIEnabled()) return pickRandom(account.replies);

  try {
    const client = getClient();
    if (!client) return pickRandom(account.replies);

    const truncated = (commentText || '').slice(0, 300);
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 40,
      temperature: 0.85,
      messages: [
        {
          role: 'system',
          content: 'You write short, friendly Facebook comment replies. Keep it to 1 sentence, natural and conversational.',
        },
        {
          role: 'user',
          content: `Reply to this Facebook comment:\n\n${truncated}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (text) return text;
  } catch {
    // fall through to random
  }

  return pickRandom(account.replies);
}

module.exports = { generateComment, generateReply };
