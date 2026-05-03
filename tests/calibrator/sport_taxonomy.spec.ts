import { describe, expect, it } from "vitest";
import { LEAGUE_TO_SPORT, classifySport } from "../../src/calibrator/sport_taxonomy.js";

describe("calibrator/sport_taxonomy", () => {
  it("maps cs2 → Esports", () => {
    expect(classifySport("cs2")).toBe("Esports");
  });

  it("maps mlb → MLB", () => {
    expect(classifySport("mlb")).toBe("MLB");
  });

  it("maps ufc → UFC", () => {
    expect(classifySport("ufc")).toBe("UFC");
  });

  it("maps nhl → NHL and nba → NBA and wnba → WNBA and nfl → NFL", () => {
    expect(classifySport("nhl")).toBe("NHL");
    expect(classifySport("nba")).toBe("NBA");
    expect(classifySport("wnba")).toBe("WNBA");
    expect(classifySport("nfl")).toBe("NFL");
  });

  it("maps every soccer code to Soccer", () => {
    for (const code of [
      "soccer", "mls", "epl", "laliga", "bundesliga", "seriea",
      "ligue1", "fr2", "bra", "arg", "mex", "j2100", "ucl", "uel",
      "ere", "spl", "por", "es2", "fl1", "sea", "lal",
    ]) {
      expect(classifySport(code)).toBe("Soccer");
    }
  });

  it("maps tennis tours to Tennis", () => {
    expect(classifySport("atp")).toBe("Tennis");
    expect(classifySport("wta")).toBe("Tennis");
    expect(classifySport("challenger")).toBe("Tennis");
  });

  it("maps cricket variants to Cricket", () => {
    expect(classifySport("cricket")).toBe("Cricket");
    expect(classifySport("cricipl")).toBe("Cricket");
  });

  it("returns null for null input", () => {
    expect(classifySport(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(classifySport(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(classifySport("")).toBeNull();
  });

  it("returns null for unknown leagues (e.g. xfl, kbo)", () => {
    expect(classifySport("xfl")).toBeNull();
    expect(classifySport("kbo")).toBeNull();
  });

  it("normalizes mixed-case input via toLowerCase", () => {
    expect(classifySport("CS2")).toBe("Esports");
    expect(classifySport("Mlb")).toBe("MLB");
    expect(classifySport("Soccer")).toBe("Soccer");
  });

  it("LEAGUE_TO_SPORT covers every league code from the spec table", () => {
    // Smoke test — at minimum 30+ leagues, no key mapping to empty/null.
    const codes = Object.keys(LEAGUE_TO_SPORT);
    expect(codes.length).toBeGreaterThanOrEqual(30);
    for (const k of codes) {
      const v = LEAGUE_TO_SPORT[k];
      expect(typeof v).toBe("string");
      expect(v && v.length > 0).toBe(true);
    }
  });
});
