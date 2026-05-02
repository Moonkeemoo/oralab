/**
 * Unit tests for SportsEventConsumer state-diff logic. WS connection
 * itself isn't tested here (covered by manual scripts/sports-ws-tap.ts);
 * we instead exercise the diff() / handleMessage() pipeline by feeding
 * synthetic Buffer payloads.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type ScoreEvent,
  SportsEventConsumer,
  type SportsRawSnapshot,
} from "../../src/feed/sports_event_consumer.js";

function makeConsumer(): { consumer: SportsEventConsumer; events: ScoreEvent[] } {
  const events: ScoreEvent[] = [];
  const consumer = new SportsEventConsumer({
    url: "wss://example.invalid/sports",
    persistSnapshots: false,
    handler: (e) => {
      events.push(e);
    },
  });
  return { consumer, events };
}

function snapshotBuf(s: SportsRawSnapshot): Buffer {
  return Buffer.from(JSON.stringify(s));
}

// Access the private handleMessage by casting — tests verify the actual
// runtime behavior of the diff pipeline.
function feed(c: SportsEventConsumer, snap: SportsRawSnapshot): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: test access to private
  return (c as any).handleMessage(snapshotBuf(snap), { debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
}

describe("SportsEventConsumer state diff", () => {
  it("first snapshot for a game emits no events (no baseline)", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, {
      gameId: "g1",
      leagueAbbreviation: "NBA",
      score: "0-0",
      period: "Q1",
      live: true,
      ended: false,
    });
    expect(events).toHaveLength(0);
  });

  it("second snapshot with score change emits score_change", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, { gameId: "g1", score: "0-0", period: "Q1", ended: false });
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q1", ended: false });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("score_change");
    expect(events[0]?.previousScore).toBe("0-0");
    expect(events[0]?.currentScore).toBe("1-0");
  });

  it("period change emits period_change", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q1", ended: false });
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q2", ended: false });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("period_change");
    expect(events[0]?.previousPeriod).toBe("Q1");
    expect(events[0]?.currentPeriod).toBe("Q2");
  });

  it("ended=true emits game_ended (and ignores subsequent updates)", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q1", ended: false });
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q4", ended: true });
    // After ended, further messages must be silently ignored
    await feed(consumer, { gameId: "g1", score: "2-0", period: "Q4", ended: true });

    const endedEvents = events.filter((e) => e.kind === "game_ended");
    expect(endedEvents).toHaveLength(1);
  });

  it("ended detected via status string (no boolean flag)", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q1", status: "inprogress" });
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q4", status: "final" });
    const endedEvents = events.filter((e) => e.kind === "game_ended");
    expect(endedEvents).toHaveLength(1);
  });

  it("ended detected via eventState.ended (alt nested location)", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, {
      gameId: "g1",
      score: "1-0",
      period: "Q1",
      eventState: { ended: false },
    });
    await feed(consumer, {
      gameId: "g1",
      score: "1-0",
      period: "Q4",
      eventState: { ended: true },
    });
    const endedEvents = events.filter((e) => e.kind === "game_ended");
    expect(endedEvents).toHaveLength(1);
  });

  it("multiple games tracked independently", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, { gameId: "g1", score: "0-0", period: "Q1" });
    await feed(consumer, { gameId: "g2", score: "0-0", period: "Q1" });
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q1" });
    expect(events).toHaveLength(1);
    expect(events[0]?.gameId).toBe("g1");
  });

  it("score change AND period change in one snapshot emits both events", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, { gameId: "g1", score: "1-0", period: "Q1" });
    await feed(consumer, { gameId: "g1", score: "1-1", period: "Q2" });
    expect(events.map((e) => e.kind).sort()).toEqual(["period_change", "score_change"]);
  });

  it("non-JSON payload silently dropped (no event, no throw)", async () => {
    const { consumer, events } = makeConsumer();
    // Inject garbage directly
    // biome-ignore lint/suspicious/noExplicitAny: test private
    await (consumer as any).handleMessage(Buffer.from("not json"), {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    expect(events).toHaveLength(0);
  });

  it("snapshot without gameId silently dropped", async () => {
    const { consumer, events } = makeConsumer();
    // biome-ignore lint/suspicious/noExplicitAny: test
    await feed(consumer, {} as any);
    expect(events).toHaveLength(0);
  });

  it("score field falls back to eventState.score when top-level missing", async () => {
    const { consumer, events } = makeConsumer();
    await feed(consumer, { gameId: "g1", eventState: { score: "1-0" } });
    await feed(consumer, { gameId: "g1", eventState: { score: "2-0" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("score_change");
    expect(events[0]?.currentScore).toBe("2-0");
  });
});
