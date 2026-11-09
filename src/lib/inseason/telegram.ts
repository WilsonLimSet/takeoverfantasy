/**
 * Telegram Bot Integration
 * Sends alerts and notifications via Telegram Bot API
 */

import type { SmartAlert } from '@/types';

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramConfig {
  botToken: string;
  chatId: string;
  appBaseUrl?: string;
}

function getConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const appBaseUrl = process.env.APP_BASE_URL || process.env.VERCEL_URL;

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
  }
  if (!chatId) {
    throw new Error('TELEGRAM_CHAT_ID environment variable is required');
  }

  return { botToken, chatId, appBaseUrl };
}

/**
 * Send a message via Telegram Bot API
 */
async function sendTelegramMessage(text: string): Promise<boolean> {
  const config = getConfig();

  try {
    const response = await fetch(`${TELEGRAM_API}/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Telegram API error:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
    return false;
  }
}


/**
 * Format a smart alert for Telegram - compact, no fluff
 */
function formatSmartAlert(alert: SmartAlert): string {
  const priorityEmoji = {
    HIGH: '🔴',
    MEDIUM: '🟡',
    LOW: '🟢',
  };

  if (alert.details) {
    return `${priorityEmoji[alert.priority]} <b>${alert.title}</b>\n${alert.details}`;
  }
  return `${priorityEmoji[alert.priority]} <b>${alert.title}</b>`;
}

/**
 * Send smart alerts via Telegram - compact format
 */
export async function sendSmartAlerts(
  alerts: SmartAlert[],
  _week: number
): Promise<boolean> {
  if (alerts.length === 0) {
    return true; // Nothing to send
  }

  let message = '';

  // Separate schedule alerts from other alerts
  const scheduleAlerts = alerts.filter(a => a.type === 'WEEKLY_SUMMARY');
  const otherAlerts = alerts.filter(a => a.type !== 'WEEKLY_SUMMARY');

  // Add non-schedule alerts first (injuries, drops, etc)
  for (let i = 0; i < otherAlerts.length; i++) {
    if (i > 0) message += '\n';
    message += formatSmartAlert(otherAlerts[i]);
  }

  // Add schedule section
  if (scheduleAlerts.length > 0) {
    const scheduleAlert = scheduleAlerts[0];
    if (message.length > 0) message += '\n\n';
    message += scheduleAlert.details;
  }

  return sendTelegramMessage(message);
}


