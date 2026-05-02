import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { notificationSettings } from "../db/schema.js";
import { logger } from "../obs/logger.js";

const KNOWN_EVENTS = [
  "buy_placed",
  "position_closed",
  "position_frozen",
  "fatal_error",
  "kill_switch_toggled",
] as const;
export type NotificationEvent = (typeof KNOWN_EVENTS)[number];
export const NOTIFICATION_EVENTS = KNOWN_EVENTS;

const CACHE_MS = 5_000;
let cache: { ts: number; map: Map<string, boolean> } | null = null;

export async function isNotificationEnabled(
  userId: number,
  event: NotificationEvent,
): Promise<boolean> {
  // Default true for all events when no row exists
  try {
    if (cache && Date.now() - cache.ts < CACHE_MS) {
      const k = `${userId}::${event}`;
      return cache.map.has(k) ? (cache.map.get(k) as boolean) : true;
    }
    const db = getDb();
    const rows = await db.query.notificationSettings.findMany();
    const map = new Map<string, boolean>();
    for (const r of rows) map.set(`${r.userId}::${r.eventKey}`, r.enabled);
    cache = { ts: Date.now(), map };
    const k = `${userId}::${event}`;
    return map.has(k) ? (map.get(k) as boolean) : true;
  } catch (err) {
    logger.debug({ err, event }, "notification_settings read failed; defaulting enabled");
    return true;
  }
}

export async function setNotificationEnabled(args: {
  userId: number;
  event: NotificationEvent;
  enabled: boolean;
}): Promise<void> {
  const db = getDb();
  const existing = await db.query.notificationSettings.findFirst({
    where: and(
      eq(notificationSettings.userId, args.userId),
      eq(notificationSettings.eventKey, args.event),
    ),
  });
  if (existing) {
    await db
      .update(notificationSettings)
      .set({ enabled: args.enabled, updatedAt: new Date() })
      .where(eq(notificationSettings.id, existing.id));
  } else {
    await db.insert(notificationSettings).values({
      userId: args.userId,
      eventKey: args.event,
      enabled: args.enabled,
    });
  }
  cache = null;
}

export async function listNotificationSettings(
  userId: number,
): Promise<{ event: NotificationEvent; enabled: boolean }[]> {
  const db = getDb();
  const rows = await db.query.notificationSettings.findMany();
  const map = new Map<string, boolean>();
  for (const r of rows) {
    if (r.userId === userId) map.set(r.eventKey, r.enabled);
  }
  return KNOWN_EVENTS.map((e) => ({ event: e, enabled: map.get(e) ?? true }));
}
