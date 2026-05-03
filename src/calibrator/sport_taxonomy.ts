/**
 * LEAGUE_TO_SPORT — single source of truth mapping raw league codes (as
 * stored on `sports_events.league` and `positions.league`) to canonical
 * sport groups used for calibrator analytics + per-sport calibration.
 *
 * Source: design spec docs/superpowers/specs/2026-05-03-calibrator-v1-port-design.md
 * (section "Sport-tag analytics"). Codes inferred from gamma + sports_events
 * historical observations across the v1 archive.
 *
 * Adding a new league: add lowercase key here. classifySport() returns null
 * for unknown leagues so analytics gracefully omit unclassified markets
 * instead of mis-bucketing them as "Other".
 */
export const LEAGUE_TO_SPORT: Record<string, string> = {
  // Esports
  cs2: "Esports",
  csgo: "Esports",
  lol: "Esports",
  val: "Esports",
  codmw: "Esports",
  dota2: "Esports",
  r6: "Esports",
  // MLB
  mlb: "MLB",
  // NBA / WNBA
  nba: "NBA",
  wnba: "WNBA",
  // NHL
  nhl: "NHL",
  // NFL
  nfl: "NFL",
  // Soccer (every domestic + continental code observed in v1)
  soccer: "Soccer",
  mls: "Soccer",
  epl: "Soccer",
  laliga: "Soccer",
  bundesliga: "Soccer",
  seriea: "Soccer",
  ligue1: "Soccer",
  fr2: "Soccer",
  bra: "Soccer",
  arg: "Soccer",
  mex: "Soccer",
  j2100: "Soccer",
  ucl: "Soccer",
  uel: "Soccer",
  ere: "Soccer",
  spl: "Soccer",
  por: "Soccer",
  es2: "Soccer",
  fl1: "Soccer",
  sea: "Soccer",
  lal: "Soccer",
  // Tennis
  atp: "Tennis",
  wta: "Tennis",
  challenger: "Tennis",
  // Combat
  ufc: "UFC",
  boxing: "Boxing",
  mma: "MMA",
  // Cricket
  cricipl: "Cricket",
  cricket: "Cricket",
};

/**
 * Map a raw league code to its canonical sport. Returns null for null/empty
 * input or unknown leagues. Case-insensitive (normalized via toLowerCase).
 */
export function classifySport(league: string | null | undefined): string | null {
  if (!league) return null;
  const lower = league.toLowerCase();
  return LEAGUE_TO_SPORT[lower] ?? null;
}
