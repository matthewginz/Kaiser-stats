import { describe, expect, it } from "vitest";
import { validateMatchEdit } from "../edit-match";

const base = { homeScoreRaw: "3", awayScoreRaw: "2", mvpCanonicalId: "016", description: " Great game " };

describe("validateMatchEdit", () => {
  it("parses scores, trims description, keeps MVP", () => {
    expect(validateMatchEdit(base)).toEqual({
      ok: true,
      edit: { homeScore: 3, awayScore: 2, mvpCanonicalId: "016", description: "Great game" },
    });
  });

  it("both blank scores = no-report game; blank MVP/description become null", () => {
    expect(validateMatchEdit({ homeScoreRaw: "", awayScoreRaw: " ", mvpCanonicalId: "", description: "" })).toEqual({
      ok: true,
      edit: { homeScore: null, awayScore: null, mvpCanonicalId: null, description: null },
    });
  });

  it("rejects one blank score", () => {
    expect(validateMatchEdit({ ...base, awayScoreRaw: "" }).ok).toBe(false);
  });

  it("rejects non-numeric, negative, and fractional scores", () => {
    for (const bad of ["x", "-1", "1.5", "100"]) {
      expect(validateMatchEdit({ ...base, homeScoreRaw: bad }).ok).toBe(false);
    }
  });
});
