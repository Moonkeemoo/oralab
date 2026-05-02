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
 */

async function main(): Promise<void> {
  bindService("ora2-bot");
  startTelemetry({ serviceName: "ora2-bot" });

  const alerter = telegramAlerterFromEnv();
  const bot = telegramBotFromEnv(alerter);
  if (!bot) {
    logger.error("ora2-bot: TELEGRAM_BOT_TOKEN unset OR allowed chat list empty — exiting");
    process.exit(1);
  }
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
