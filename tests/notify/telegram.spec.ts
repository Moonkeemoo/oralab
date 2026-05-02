import { describe, expect, it, vi } from "vitest";
import { TelegramAlerter } from "../../src/notify/telegram.js";

function mkFetcher(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string | URL, init?: RequestInit) =>
    impl(String(url), init ?? {})) as unknown as typeof fetch;
}

function okResp(body: object = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TelegramAlerter", () => {
  it("noop when token empty (returns false, never calls fetch)", async () => {
    const fetcher = vi.fn();
    const a = new TelegramAlerter({
      token: "",
      chatId: "123",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await a.send("hi")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("noop when chatId empty", async () => {
    const fetcher = vi.fn();
    const a = new TelegramAlerter({
      token: "T",
      chatId: "",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await a.send("hi")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts JSON body to Bot API on send()", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const fetcher = mkFetcher(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body));
      return okResp();
    });
    const a = new TelegramAlerter({ token: "TOK", chatId: "CHAT", fetcher });
    expect(await a.send("hello")).toBe(true);
    expect(capturedUrl).toBe("https://api.telegram.org/botTOK/sendMessage");
    expect(capturedBody).toMatchObject({
      chat_id: "CHAT",
      text: "hello",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });

  it("returns false on 'chat not found' but doesn't throw; warns once", async () => {
    let calls = 0;
    const fetcher = mkFetcher(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
        { status: 400 },
      );
    });
    const a = new TelegramAlerter({ token: "T", chatId: "X", fetcher });
    expect(await a.send("first")).toBe(false);
    expect(await a.send("second")).toBe(false);
    expect(calls).toBe(2);
  });

  it("survives fetcher throw (returns false)", async () => {
    const fetcher = mkFetcher(async () => {
      throw new Error("network down");
    });
    const a = new TelegramAlerter({ token: "T", chatId: "X", fetcher });
    expect(await a.send("hi")).toBe(false);
  });

  it("buyPlaced helper formats HTML message correctly", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = mkFetcher(async (_, init) => {
      body = JSON.parse(String(init.body));
      return okResp();
    });
    const a = new TelegramAlerter({ token: "T", chatId: "X", fetcher });
    await a.buyPlaced({
      positionId: 42,
      asset: "9876543210",
      title: "Lakers vs Celtics",
      shares: 5.123,
      price: 0.55,
      usdSpent: 2.82,
    });
    const text = body["text"] as string;
    expect(text).toContain("BUY filled");
    expect(text).toContain("pos #42");
    expect(text).toContain("Lakers vs Celtics");
    expect(text).toContain("5.1230");
    expect(text).toContain("0.550");
    expect(text).toContain("$2.82");
  });

  it("positionClosed shows + sign for profit", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = mkFetcher(async (_, init) => {
      body = JSON.parse(String(init.body));
      return okResp();
    });
    const a = new TelegramAlerter({ token: "T", chatId: "X", fetcher });
    await a.positionClosed({
      positionId: 7,
      asset: "asset",
      title: "test",
      closeReason: "chain_sell_filled",
      netPnlUsd: 1.23,
      pnlPct: 0.041,
    });
    const text = body["text"] as string;
    expect(text).toContain("+$1.23");
    expect(text).toContain("+4.1%");
    expect(text).toContain("🔵");
  });

  it("positionClosed shows red for loss", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = mkFetcher(async (_, init) => {
      body = JSON.parse(String(init.body));
      return okResp();
    });
    const a = new TelegramAlerter({ token: "T", chatId: "X", fetcher });
    await a.positionClosed({
      positionId: 7,
      asset: "asset",
      title: "test",
      closeReason: "sell_filled_chain_lag",
      netPnlUsd: -0.5,
      pnlPct: -0.07,
    });
    const text = body["text"] as string;
    expect(text).toContain("$-0.50");
    expect(text).toContain("🔴");
  });

  it("positionFrozen / killSwitchToggled / fatalError all post", async () => {
    const calls: string[] = [];
    const fetcher = mkFetcher(async (_, init) => {
      const body = JSON.parse(String(init.body)) as { text: string };
      calls.push(body.text);
      return okResp();
    });
    const a = new TelegramAlerter({ token: "T", chatId: "X", fetcher });
    await a.positionFrozen({ positionId: 1, asset: "a", reason: "drift" });
    await a.killSwitchToggled(true, "reconciler");
    await a.killSwitchToggled(false, "operator");
    await a.fatalError("trader", new Error("db down"));
    expect(calls.length).toBe(4);
    expect(calls[0]).toContain("FROZEN");
    expect(calls[1]).toContain("KILL_SWITCH ON");
    expect(calls[2]).toContain("KILL_SWITCH OFF");
    expect(calls[3]).toContain("FATAL");
    expect(calls[3]).toContain("db down");
  });

  it("HTML special chars in title are escaped", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = mkFetcher(async (_, init) => {
      body = JSON.parse(String(init.body));
      return okResp();
    });
    const a = new TelegramAlerter({ token: "T", chatId: "X", fetcher });
    await a.buyPlaced({
      positionId: 1,
      asset: "a",
      title: "<script>alert(1)</script>",
      shares: 1,
      price: 0.5,
      usdSpent: 0.5,
    });
    const text = body["text"] as string;
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});
