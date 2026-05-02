import process from "node:process";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { positions } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import { isRuntimeKillSwitchActive, setRuntimeKillSwitch } from "./kill_switch.js";
import { TelegramAlerter } from "./telegram.js";

/**
 * TelegramBot — long-poll command handler. Runs as ora2-bot service.
 * Allows Taras to send /status /positions /pnl /pause /resume from
 * @Oralab_bot.
 *
 * Why long-poll vs webhook: zero infra (no public HTTPS endpoint), works
 * from a laptop, fits the P2a "minimal" scope. Webhook can come in P3a
 * once we have ora2-api on a stable URL.
 *
 * Auth: only chat IDs in TELEGRAM_ALLOWED_CHAT_IDS get a response. Stops
 * random users who somehow find the bot from being able to /pause.
 */

interface BotCfg {
  token: string;
  allowedChatIds: ReadonlySet<string>;
  alerter: TelegramAlerter;
  /** poll timeout for getUpdates; default 25s. Telegram caps at 50s. */
  longPollTimeoutSec?: number;
  /** Optional fetch override for tests. */
  fetcher?: typeof fetch;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    text?: string;
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

const ACTIVE_STATUSES = ["PENDING", "FILLED", "OPEN", "EXITING"] as const;

export class TelegramBot {
  private offset = 0;
  private stopped = false;
  private readonly fetcher: typeof fetch;

  constructor(private readonly cfg: BotCfg) {
    this.fetcher = cfg.fetcher ?? globalThis.fetch;
  }

  async start(): Promise<void> {
    this.stopped = false;
    logger.info(
      { allowedChats: [...this.cfg.allowedChatIds] },
      "TelegramBot long-poll loop started",
    );
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.getUpdates();
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handleUpdate(u);
        }
      } catch (err) {
        logger.warn({ err }, "TelegramBot poll iteration failed; backing off 5s");
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const timeout = this.cfg.longPollTimeoutSec ?? 25;
    const url = `https://api.telegram.org/bot${this.cfg.token}/getUpdates?offset=${this.offset}&timeout=${timeout}`;
    const resp = await this.fetcher(url);
    if (!resp.ok) {
      throw new Error(`getUpdates HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as TelegramResponse<TelegramUpdate[]>;
    if (!json.ok || !json.result) return [];
    return json.result;
  }

  private async handleUpdate(u: TelegramUpdate): Promise<void> {
    const msg = u.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    if (!this.cfg.allowedChatIds.has(chatId)) {
      logger.debug({ chatId, text: msg.text.slice(0, 60) }, "TelegramBot: ignored unauthorized");
      return;
    }
    const cmd = msg.text.trim().split(/\s+/)[0]?.toLowerCase();
    if (!cmd) return;
    try {
      const reply = await this.dispatch(cmd);
      if (reply) await this.cfg.alerter.send(reply);
    } catch (err) {
      logger.error({ err, cmd }, "TelegramBot command threw");
      await this.cfg.alerter.send(`<b>error</b>: ${(err as Error).message}`);
    }
  }

  /** Public for testing. */
  async dispatch(cmd: string): Promise<string | null> {
    switch (cmd) {
      case "/status":
        return this.cmdStatus();
      case "/positions":
        return this.cmdPositions();
      case "/pnl":
        return this.cmdPnl();
      case "/pause":
        return this.cmdPause();
      case "/resume":
        return this.cmdResume();
      case "/help":
      case "/start":
        return this.cmdHelp();
      default:
        return `unknown command <code>${cmd}</code>. /help for list.`;
    }
  }

  private async cmdStatus(): Promise<string> {
    const db = getDb();
    const active = await db.query.positions.findMany({
      where: inArray(positions.status, [...ACTIVE_STATUSES]),
      columns: { id: true, status: true },
    });
    const ks = await isRuntimeKillSwitchActive();
    const env = (process.env["DRY_RUN"] ?? "true").toLowerCase() === "true" ? "DRY" : "LIVE";
    return [
      "<b>ora2 status</b>",
      `mode: <code>${env}</code>`,
      `kill_switch: ${ks ? "🟥 ON" : "🟩 OFF"}`,
      `active positions: <b>${active.length}</b>`,
    ].join("\n");
  }

  private async cmdPositions(): Promise<string> {
    const db = getDb();
    const rows = await db.query.positions.findMany({
      where: inArray(positions.status, [...ACTIVE_STATUSES]),
      orderBy: desc(positions.id),
      limit: 10,
    });
    if (rows.length === 0) return "no active positions";
    const lines = rows.map(
      (p) =>
        `#${p.id} <b>${p.status}</b> ${Number(p.shares ?? 0).toFixed(3)} sh @ ${Number(p.fillPrice ?? 0).toFixed(3)} (sweep ${p.sweepCount ?? 0})`,
    );
    return ["<b>active positions</b>", ...lines].join("\n");
  }

  private async cmdPnl(): Promise<string> {
    const db = getDb();
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const since24h = now - dayMs;
    const rows = await db.query.positions.findMany({
      where: and(
        eq(positions.status, "CLOSED"),
        gte(positions.lastStateChangeTs, since24h),
      ),
      columns: { id: true, entryCostUsd: true, lastStateChangeTs: true, conditionId: true },
    });
    // For simplicity sum (sell - entry) approximated via fills table per position would be
    // accurate; here we surface count + entry exposure as a proxy until ora2-api adds a
    // dedicated /pnl endpoint with full fill aggregation (P2a-3).
    const totalEntryUsd = rows.reduce((s, r) => s + Number(r.entryCostUsd ?? 0), 0);
    return [
      "<b>P&L (last 24h, closed positions)</b>",
      `closed count: ${rows.length}`,
      `total entry exposure: $${totalEntryUsd.toFixed(2)}`,
      "(detailed sell-side aggregation in /api/pnl REST endpoint)",
    ].join("\n");
  }

  private async cmdPause(): Promise<string> {
    await setRuntimeKillSwitch({ active: true, reason: "telegram /pause" });
    return "🟥 KILL_SWITCH ON — new BUYs halted (SELLs continue)";
  }

  private async cmdResume(): Promise<string> {
    await setRuntimeKillSwitch({ active: false, reason: "telegram /resume" });
    return "🟩 KILL_SWITCH OFF — entries resumed";
  }

  private cmdHelp(): string {
    return [
      "<b>ora2 bot commands</b>",
      "/status — mode + kill switch + active count",
      "/positions — list active positions",
      "/pnl — last-24h closed summary",
      "/pause — halt new BUYs (SELLs unaffected)",
      "/resume — re-enable entries",
    ].join("\n");
  }
}

export function telegramBotFromEnv(alerter: TelegramAlerter): TelegramBot | null {
  const token = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
  if (!token) return null;
  const allowed = (process.env["TELEGRAM_ALLOWED_CHAT_IDS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allowed.length === 0) {
    logger.warn(
      "TelegramBot disabled: TELEGRAM_ALLOWED_CHAT_IDS empty (would accept anyone)",
    );
    return null;
  }
  return new TelegramBot({ token, allowedChatIds: new Set(allowed), alerter });
}
