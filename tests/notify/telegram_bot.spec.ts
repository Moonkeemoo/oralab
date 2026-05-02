/**
 * Unit tests for TelegramBot dispatch + auth. Long-poll loop + actual
 * HTTP fetch are skipped (covered by smoke run); we exercise dispatch()
 * directly with a mocked alerter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramBot } from "../../src/notify/telegram_bot.js";
import { TelegramAlerter } from "../../src/notify/telegram.js";

function makeAlerter(): { alerter: TelegramAlerter; sent: string[] } {
  const sent: string[] = [];
  const alerter = new TelegramAlerter({
    token: "T",
    chatId: "1",
    fetcher: (async (_: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      sent.push(body.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { alerter, sent };
}

describe("TelegramBot.dispatch", () => {
  beforeEach(() => {
    vi.stubEnv("DRY_RUN", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("/help shows commands", async () => {
    const { alerter } = makeAlerter();
    const bot = new TelegramBot({
      token: "T",
      allowedChatIds: new Set(["1"]),
      alerter,
    });
    const reply = await bot.dispatch("/help");
    expect(reply).toContain("/status");
    expect(reply).toContain("/positions");
    expect(reply).toContain("/pause");
  });

  it("/start aliases to /help", async () => {
    const { alerter } = makeAlerter();
    const bot = new TelegramBot({ token: "T", allowedChatIds: new Set(["1"]), alerter });
    const reply = await bot.dispatch("/start");
    expect(reply).toContain("/status");
  });

  it("unknown command returns hint", async () => {
    const { alerter } = makeAlerter();
    const bot = new TelegramBot({ token: "T", allowedChatIds: new Set(["1"]), alerter });
    const reply = await bot.dispatch("/foo");
    expect(reply).toContain("unknown command");
    expect(reply).toContain("/help");
  });

  // /status / /positions / /pnl / /pause / /resume hit DB; covered via
  // smoke run, not unit tests (no DB harness). Future: switch to integration
  // suite once tests/integration has shared DB setup.
});
