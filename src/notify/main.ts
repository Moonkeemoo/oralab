import process from "node:process";
import { closeDb } from "../db/client.js";
import { bindService, logger } from "../obs/logger.js";
import { shutdownTelemetry, startTelemetry } from "../obs/tracer.js";
import { telegramAlerterFromEnv } from "./telegram.js";
import { telegramBotFromEnv } from "./telegram_bot.js";

/**
 * ora2-bot entry point — runs the Telegram long-poll command bot.
 * Separate from ora2-trader so a flaky bot doesn't block trading.
 *
 * Outbound alerts live inline in trader/feed processes (telegramAlerter
 * is also constructed there). This service handles INBOUND commands only.
 *
 * On startup, registers the Mini App URL (env MINI_APP_URL) as the bot's
 * chat menu button so user gets a one-tap "Open" launcher.
 */

async function setMenuButton(token: string, miniAppUrl: string): Promise<void> {
  if (!miniAppUrl) {
    logger.info("MINI_APP_URL unset — skipping setChatMenuButton");
    return;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        menu_button: {
          type: "web_app",
          text: "Open ora2",
          web_app: { url: miniAppUrl },
        },
      }),
    });
    const body = (await resp.json()) as { ok: boolean; description?: string };
    if (body.ok) {
      logger.info({ miniAppUrl }, "Telegram chat menu button set → Open ora2");
    } else {
      logger.warn({ body }, "setChatMenuButton failed");
    }
  } catch (err) {
    logger.warn({ err }, "setChatMenuButton threw");
  }
}

async function main(): Promise<void> {
  bindService("ora2-bot");
  startTelemetry({ serviceName: "ora2-bot" });

  const alerter = telegramAlerterFromEnv();
  const bot = telegramBotFromEnv(alerter);
  if (!bot) {
    logger.error("ora2-bot: TELEGRAM_BOT_TOKEN unset OR allowed chat list empty — exiting");
    process.exit(1);
  }
  const token = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
  await setMenuButton(token, process.env["MINI_APP_URL"] ?? "");
  await bot.start();
  await alerter.send("✅ <b>ora2-bot online</b> — /help for commands");

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "ora2-bot shutting down");
    bot.stop();
    await shutdownTelemetry();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
