import { afterEach, describe, expect, it } from "vitest";
import { _resetEntryQueue, serializedEntry } from "../../src/feed/entry_mutex.js";

afterEach(() => {
  _resetEntryQueue();
});

describe("serializedEntry — bulletproof entry mutex", () => {
  it("runs single call sequentially when no overlap", async () => {
    const calls: string[] = [];
    await serializedEntry(1, 1, async () => {
      calls.push("a-start");
      await new Promise((r) => setTimeout(r, 10));
      calls.push("a-end");
    });
    expect(calls).toEqual(["a-start", "a-end"]);
  });

  it("serializes 5 concurrent calls for same (user, strategy)", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const job = (id: number) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end-${id}`);
      inFlight -= 1;
    };

    await Promise.all([
      serializedEntry(1, 1, job(0)),
      serializedEntry(1, 1, job(1)),
      serializedEntry(1, 1, job(2)),
      serializedEntry(1, 1, job(3)),
      serializedEntry(1, 1, job(4)),
    ]);

    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      "start-0",
      "end-0",
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
      "start-4",
      "end-4",
    ]);
  });

  it("different (user, strategy) keys do NOT block each other", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const job = (id: string) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end-${id}`);
      inFlight -= 1;
    };

    await Promise.all([
      serializedEntry(1, 1, job("user1-strat1")),
      serializedEntry(1, 2, job("user1-strat2")),
      serializedEntry(2, 1, job("user2-strat1")),
    ]);
    expect(maxInFlight).toBe(3);
  });

  it("error in one job does not block subsequent jobs", async () => {
    const completed: number[] = [];
    const a = serializedEntry(1, 1, async () => {
      throw new Error("boom");
    });
    const b = serializedEntry(1, 1, async () => {
      completed.push(2);
      return 42;
    });
    await expect(a).rejects.toThrow("boom");
    expect(await b).toBe(42);
    expect(completed).toEqual([2]);
  });

  it("returns each call's own value", async () => {
    const a = serializedEntry(1, 1, async () => "alpha");
    const b = serializedEntry(1, 1, async () => "beta");
    expect(await a).toBe("alpha");
    expect(await b).toBe("beta");
  });
});
