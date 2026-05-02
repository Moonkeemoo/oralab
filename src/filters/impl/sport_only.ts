import { type Filter, PASS, SKIP } from "../types.js";

/**
 * sport_only — P1 sports-focused gate. Cuts non-sports markets from the
 * pipeline. Heuristic: check signal.payload.title for known sports league
 * patterns (NFL/NHL/NBA/MLB/Soccer/Tennis/Esports) and "X vs Y" framing.
 *
 * Conservative — false negatives prefer to reject (we'd rather miss a sport
 * market than enter a politics/crypto market in P1).
 */

const SPORT_PATTERNS: readonly RegExp[] = [
  /\b(NFL|NHL|NBA|MLB|MLS|UFC|WNBA|NCAAB|NCAAF|CFB|CBB|EPL|UCL|UEFA|FIFA|La\s?Liga|Serie\s?A|Bundesliga)\b/i,
  /\b(LoL|League of Legends|CS:GO|CS2|Counter-Strike|Dota|Valorant|StarCraft)\b/i,
  /\b(NHL|NBA|NFL|MLB):/i,
  /\b(vs|@)\s+[A-Z][a-zA-ZЀ-ӿ]/, // "Lakers vs Mavs", "Chiefs @ Bills"
];

const SPORT_KEYWORDS: readonly string[] = [
  "moneyline",
  "spread",
  "over/under",
  "total points",
  "first goal",
  "first to score",
  "to win the match",
];

export const sportOnly: Filter = {
  name: "sport_only",
  description: "P1 gate: only sports markets — heuristic on title text",
  evaluate(ctx) {
    const title = String(ctx.signal.payload["title"] ?? "");
    if (!title) return SKIP({ v: 0, t: 1 }, "title missing — cannot classify");
    const haystack = title.toLowerCase();
    const matched =
      SPORT_PATTERNS.some((rx) => rx.test(title)) ||
      SPORT_KEYWORDS.some((k) => haystack.includes(k));
    if (!matched) return SKIP({ v: 0, t: 1 }, "non-sports title");
    return PASS({ v: 1, t: 1 });
  },
};
