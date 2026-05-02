/**
 * Filter audit (week-1 spike per docs/REPO_KICKOFF.md §8 Day 4-5).
 *
 * Reads v1 archive's decision_log.jsonl. Each entry has:
 *   filter_values: { [filter_name]: { v: number, t: number | null } }
 *   skip_reason: string | null   // names the filter that caused skip
 *   ts: number (epoch seconds)
 *
 * Outputs Markdown table `docs/v2/filter_audit.md` with:
 *   filter | fire_count | skip_count | skip_pct | last_fired | port_or_cut
 *
 * port  = filter caused at least 1 skip OR fired in >= 100 decisions
 * cut   = filter never fired or never caused skip in 30d window (dead code)
 *
 * Conservative bias: we PORT by default; "cut" only when overwhelming evidence
 * the filter is dead. hard_safety always ports (money-safety, see CLAUDE.md).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ARCHIVE = join(homedir(), "Documents/GitHub/oralab-v1-archive-2026-05-02.tar.gz");
const EXTRACT = "/tmp/oralab-filter-audit";
const OUT = join(process.cwd(), "docs/v2/filter_audit.md");

interface DecisionEntry {
  ts: number;
  whale_wallet?: string;
  decision: string;
  skip_reason?: string | null;
  filter_values?: Record<string, { v: number; t: number | null }>;
}

interface FilterStat {
  fireCount: number;
  skipCount: number;
  lastFiredAt: number;
  exampleValues: number[];
}

function ensureExtract() {
  if (existsSync(EXTRACT)) rmSync(EXTRACT, { recursive: true });
  mkdirSync(EXTRACT, { recursive: true });
  if (!existsSync(ARCHIVE)) throw new Error(`archive not found at ${ARCHIVE}`);
  execSync(`tar xzf ${ARCHIVE} -C ${EXTRACT}`);
}

function readDecisions(): DecisionEntry[] {
  const stagingPath = join(EXTRACT, "v1-archive-staging/output");
  const live = readFileSync(join(stagingPath, "decision_log.jsonl"), "utf8");
  const archived = readArchivedGz(stagingPath);
  const all = `${archived}${archived.endsWith("\n") || archived === "" ? "" : "\n"}${live}`;
  const out: DecisionEntry[] = [];
  for (const line of all.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DecisionEntry);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function readArchivedGz(stagingPath: string): string {
  const archDir = join(stagingPath, "archive");
  if (!existsSync(archDir)) return "";
  const files = execSync(`ls ${archDir}/*.jsonl.gz 2>/dev/null || true`).toString().trim().split("\n").filter(Boolean);
  let combined = "";
  for (const f of files) {
    try {
      const content = execSync(`gunzip -c "${f}"`).toString();
      combined += content;
    } catch {
      // skip unreadable archive
    }
  }
  return combined;
}

function aggregate(entries: DecisionEntry[]): Map<string, FilterStat> {
  const stats = new Map<string, FilterStat>();
  for (const e of entries) {
    if (!e.filter_values || typeof e.filter_values !== "object") continue;
    for (const [name, fv] of Object.entries(e.filter_values)) {
      let s = stats.get(name);
      if (!s) {
        s = { fireCount: 0, skipCount: 0, lastFiredAt: 0, exampleValues: [] };
        stats.set(name, s);
      }
      s.fireCount += 1;
      if (e.ts > s.lastFiredAt) s.lastFiredAt = e.ts;
      if (s.exampleValues.length < 3) s.exampleValues.push(fv.v);
      if (e.skip_reason === name) s.skipCount += 1;
    }
  }
  return stats;
}

function decide(name: string, s: FilterStat, totalDecisions: number): "port" | "cut" | "review" {
  if (name === "hard_safety") return "port";
  if (s.skipCount > 0) return "port";
  if (s.fireCount >= 100) return "port";
  if (s.fireCount === 0) return "cut";
  if (s.fireCount < 10 && totalDecisions > 500) return "review";
  return "review";
}

function format(stats: Map<string, FilterStat>, totalDecisions: number, oldest: number, newest: number): string {
  const rows = Array.from(stats.entries())
    .map(([name, s]) => ({ name, ...s, decision: decide(name, s, totalDecisions) }))
    .sort((a, b) => b.skipCount - a.skipCount || b.fireCount - a.fireCount);

  const tsFormat = (ts: number) => (ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 19) : "—");
  const windowSeconds = newest - oldest;
  const windowLabel =
    windowSeconds < 3600
      ? `~${(windowSeconds / 60).toFixed(1)} minutes`
      : windowSeconds < 86_400
        ? `~${(windowSeconds / 3600).toFixed(1)} hours`
        : `~${(windowSeconds / 86_400).toFixed(1)} days`;
  const tooShortWindow = windowSeconds < 86_400;

  const md: string[] = [];
  md.push("# Filter Audit — week-1 spike");
  md.push("");
  md.push(`> Source: \`oralab-v1-archive-2026-05-02.tar.gz\` → \`output/decision_log.jsonl\` (live) + \`output/archive/decision_log-*.jsonl.gz\` (archived).  `);
  md.push(`> Window: ${tsFormat(oldest)} → ${tsFormat(newest)} (${windowLabel})  `);
  md.push(`> Total decisions: ${totalDecisions}  `);
  md.push(`> Generated: ${new Date().toISOString().slice(0, 19)}`);
  md.push("");
  if (tooShortWindow) {
    md.push("> ⚠ **Caveat:** the audit window is much smaller than the planned 30 days. v1 was largely down");
    md.push("> after CLOB V2 launched 2026-04-27 (`order_version_mismatch`), so the decision log captured only");
    md.push("> the brief windows where the bot was up. \"cut\" decisions in this window may be premature —");
    md.push("> a filter labeled `review` may simply not have had inputs that would trigger it. Re-run the audit");
    md.push("> against captured logs once v2 has 7+ days of DRY data (P3a).");
    md.push("");
  }
  md.push("## Method");
  md.push("");
  md.push("- `fire_count` = decisions where the filter appeared in `filter_values` (it was checked)");
  md.push("- `skip_count` = decisions where `skip_reason === filter_name` (it caused a skip)");
  md.push("- `port` = `hard_safety` always; OR skip_count > 0; OR fire_count ≥ 100");
  md.push("- `cut` = fire_count = 0 in window (filter never reached pipeline → dead)");
  md.push("- `review` = fired but never caused skip in window — manual judgment");
  md.push("");
  md.push("## Decision table");
  md.push("");
  md.push("| Filter | Fire | Skip | Skip % | Last fired | Decision |");
  md.push("|---|---:|---:|---:|---|:---:|");
  for (const r of rows) {
    const pct = r.fireCount > 0 ? ((r.skipCount * 100) / r.fireCount).toFixed(1) : "0.0";
    const badge = r.decision === "port" ? "**port**" : r.decision === "cut" ? "~~cut~~" : "_review_";
    md.push(`| \`${r.name}\` | ${r.fireCount} | ${r.skipCount} | ${pct}% | ${tsFormat(r.lastFiredAt)} | ${badge} |`);
  }
  md.push("");
  md.push("## Summary");
  md.push("");
  const counts = { port: 0, cut: 0, review: 0 };
  for (const r of rows) counts[r.decision] += 1;
  md.push(`- **Port** (carry to v2): ${counts.port}`);
  md.push(`- **Cut** (dead in window): ${counts.cut}`);
  md.push(`- **Review** (manual judgment needed): ${counts.review}`);
  md.push("");
  md.push("## Notes");
  md.push("");
  md.push("- `hard_safety` is unconditional port (money-safety; see CLAUDE.md kickoff decisions).");
  md.push("- `review` filters: fired but never caused skip in window. Likely 'always-pass with current params' — keep but consider tightening params, OR cut if confirmed dead.");
  md.push("- v1 used Python filters in `core/filters/`; v2 ports logic to TypeScript with `Strategy.evaluate()` filter pipeline. See `docs/architecture.html` §10.");
  md.push("");
  return md.join("\n");
}

function main() {
  console.log("[audit] extracting archive…");
  ensureExtract();

  console.log("[audit] reading decision_log…");
  const entries = readDecisions();
  console.log(`[audit] entries: ${entries.length}`);
  if (entries.length === 0) throw new Error("no decision entries — archive empty?");

  const stats = aggregate(entries);
  console.log(`[audit] distinct filters: ${stats.size}`);

  const ts = entries.map((e) => e.ts).filter((n) => typeof n === "number" && Number.isFinite(n));
  const oldest = Math.min(...ts);
  const newest = Math.max(...ts);

  const md = format(stats, entries.length, oldest, newest);

  mkdirSync(join(process.cwd(), "docs/v2"), { recursive: true });
  writeFileSync(OUT, md);
  console.log(`[audit] wrote ${OUT}`);

  rmSync(EXTRACT, { recursive: true });
}

main();
