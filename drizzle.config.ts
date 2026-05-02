import "node:process";
import { defineConfig } from "drizzle-kit";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL not set — copy .env.example to .env and fill it");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
