import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof makeDb> | null = null;

function makeDb(sql: ReturnType<typeof postgres>) {
  return drizzle(sql, { schema, logger: false });
}

export function getDb(): ReturnType<typeof makeDb> {
  if (_db) return _db;
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL not set");
  _client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  _db = makeDb(_client);
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = null;
    _db = null;
  }
}

export type Db = ReturnType<typeof getDb>;
export { schema };
