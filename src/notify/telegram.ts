import process from "node:process";
import { logger } from "../obs/logger.js";

/**
 * TelegramAlerter — outbound bot notifications via Telegram Bot API.
 *
 * Talks directly to https://api.telegram.org/bot<TOKEN>/sendMessage; no
 * polling, no command handling (that lives in src/notify/telegram_bot.ts).
 *
 * Requires:
 *   TELEGRAM_BOT_TOKEN — from @BotFather
 *   TELEGRAM_CHAT_ID  — recipient chat (the user must /start the bot first;
 *     Telegram blocks bot→user messages until the user initiates).
 *
 * No-op if either env var is unset (so local DRY runs don't fail). Errors
 * are logged and swallowed — alerter never throws into the trading path.
 *
 * Rate-limit: Telegram allows ≤30 msg/sec/bot, ≤1 msg/sec/chat. We don't
 * batch yet — alert volume is low enough that this hasn't been an issue.
 */

interface TelegramAlerterCfg {
  token: string;
  chatId: string;
  /** parse_mode for outgoing messages; default "HTML" allows <b><code> etc. */
  parseMode?: "HTML" | "MarkdownV2" | "Markdown" | undefined;
  /** Optional fetch override for tests. */
  fetcher?: typeof fetch;
}

export class TelegramAlerter {
  private readonly fetcher: typeof fetch;
  private warnedUnreachable = false;

  constructor(private readonly cfg: TelegramAlerterCfg) {
    this.fetcher = cfg.fetcher ?? globalThis.fetch;
  }

  async send(text: string): Promise<boolean> {
    if (!this.cfg.token || !this.cfg.chatId) return false;
    const url = `https://api.telegram.org/bot${this.cfg.token}/sendMessage`;
    const body = {
      chat_id: this.cfg.chatId,
      text,
      parse_mode: this.cfg.parseMode ?? "HTML",
      disable_web_page_preview: true,
    };
    try {
      const resp = await this.fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        // First successful send — clear unreachable warning so future failures log fresh.
        this.warnedUnreachable = false;
        return true;
      }
      const errBody = (await resp.json().catch(() => ({}))) as {
        description?: string;
        error_code?: number;
      };
      if (errBody.error_code === 400 && /chat not found/i.test(errBody.description ?? "")) {
        if (!this.warnedUnreachable) {
          logger.warn(
            { chatId: this.cfg.chatId },
            "Telegram chat not found — user must /start the bot before alerts can be delivered",
          );
          this.warnedUnreachable = true;
        }
        return false;
      }
      logger.warn({ status: resp.status, errBody }, "Telegram sendMessage failed");
      return false;
    } catch (err) {
      logger.warn({ err }, "Telegram sendMessage threw");
      return false;
    }
  }

  // ── Convenience helpers (each returns boolean for test/observability) ──

  buyPlaced(args: {
    positionId: number;
    asset: string;
    title?: string | undefined;
    shares: number;
    price: number;
    usdSpent: number;
  }): Promise<boolean> {
    const t = args.title ? args.title.slice(0, 80) : args.asset.slice(0, 12);
    return this.send(
      [
        "🟢 <b>BUY filled</b>",
        `pos #${args.positionId} • <code>${escapeHtml(t)}</code>`,
        `${args.shares.toFixed(4)} sh @ ${args.price.toFixed(3)}  =  $${args.usdSpent.toFixed(2)}`,
      ].join("\n"),
    );
  }

  positionClosed(args: {
    positionId: number;
    asset: string;
    title?: string | undefined;
    closeReason: string;
    netPnlUsd: number;
    pnlPct: number;
  }): Promise<boolean> {
    const sign = args.netPnlUsd >= 0 ? "+" : "";
    const emoji = args.netPnlUsd >= 0 ? "🔵" : "🔴";
    const t = args.title ? args.title.slice(0, 80) : args.asset.slice(0, 12);
    return this.send(
      [
        `${emoji} <b>Position closed</b> (${args.closeReason})`,
        `pos #${args.positionId} • <code>${escapeHtml(t)}</code>`,
        `P&L: ${sign}$${args.netPnlUsd.toFixed(2)} (${sign}${(args.pnlPct * 100).toFixed(1)}%)`,
      ].join("\n"),
    );
  }

  positionFrozen(args: {
    positionId: number;
    asset: string;
    reason: string;
  }): Promise<boolean> {
    return this.send(
      [
        "❄️ <b>Position FROZEN — manual recovery required</b>",
        `pos #${args.positionId} • <code>${escapeHtml(args.asset.slice(0, 16))}</code>`,
        `reason: ${escapeHtml(args.reason)}`,
      ].join("\n"),
    );
  }

  killSwitchToggled(active: boolean, source: string): Promise<boolean> {
    return this.send(
      active
        ? `⛔ <b>KILL_SWITCH ON</b> (source: ${escapeHtml(source)}) — new BUYs halted, SELLs continue`
        : `✅ <b>KILL_SWITCH OFF</b> (source: ${escapeHtml(source)}) — entries resumed`,
    );
  }

  fatalError(component: string, err: Error): Promise<boolean> {
    return this.send(
      [
        `🚨 <b>FATAL</b> in ${escapeHtml(component)}`,
        `<code>${escapeHtml(err.message ?? String(err)).slice(0, 600)}</code>`,
      ].join("\n"),
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build alerter from process.env. Returns a no-op stub if either
 * TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is unset.
 */
export function telegramAlerterFromEnv(): TelegramAlerter {
  return new TelegramAlerter({
    token: process.env["TELEGRAM_BOT_TOKEN"] ?? "",
    chatId: process.env["TELEGRAM_CHAT_ID"] ?? "",
  });
}
