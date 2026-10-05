import { describe, expect, it } from "vitest";
import {
  formatMatchDateLabel,
  formatPlusMinus,
  formatScoreLine,
  formatWDL,
  getMultiGoalNickname,
  redactReportText,
} from "../format";

describe("formatMatchDateLabel", () => {
  it("formats a date-only ISO string in UTC regardless of local time zone", () => {
    // 2026-07-12 is a Sunday. If this were parsed in local time on a
    // negative-UTC-offset machine, it could shift back to Saturday.
    expect(formatMatchDateLabel("2026-07-12")).toBe("SUN JUL 12");
    expect(formatMatchDateLabel("2026-07-11")).toBe("SAT JUL 11");
  });
});

describe("formatScoreLine", () => {
  it("joins two scores with an en dash", () => {
    expect(formatScoreLine(2, 4)).toBe("2 – 4");
  });

  it("returns 'No report' for a no-report game (null score)", () => {
    expect(formatScoreLine(null, null)).toBe("No report");
  });
});

describe("formatWDL", () => {
  it("joins wins-ties-losses in that order", () => {
    expect(formatWDL(18, 6, 11)).toBe("18-6-11");
  });
});

describe("formatPlusMinus", () => {
  it("prefixes positive values with a plus sign", () => {
    expect(formatPlusMinus(7)).toBe("+7");
  });

  it("leaves zero and negative values unprefixed", () => {
    expect(formatPlusMinus(0)).toBe("0");
    expect(formatPlusMinus(-3)).toBe("-3");
  });
});

describe("getMultiGoalNickname", () => {
  it("returns null for 0 or 1 goals — nothing notable yet", () => {
    expect(getMultiGoalNickname(0)).toBeNull();
    expect(getMultiGoalNickname(1)).toBeNull();
  });

  it("names 2 through 6 goals", () => {
    expect(getMultiGoalNickname(2)).toBe("Brace");
    expect(getMultiGoalNickname(3)).toBe("Hat-trick");
    expect(getMultiGoalNickname(4)).toBe("Poker");
    expect(getMultiGoalNickname(5)).toBe("Glut");
    expect(getMultiGoalNickname(6)).toBe("Double Hat-trick");
  });

  it("returns null beyond 6 rather than guessing a name", () => {
    expect(getMultiGoalNickname(7)).toBeNull();
  });
});

describe("redactReportText", () => {
  it("strips email addresses and ages from public report text, leaving the rest", () => {
    expect(
      redactReportText(
        "Vadim (organizer@yahoo.com), 2026-05-17:\nCy, Ari (15 year old, he replaced Bex), Eli. Dov is 16 years old, he can play. 8-yr-old fan watched. 5 goals in 2 years.",
      ),
    ).toBe(
      "Vadim ([email removed]), 2026-05-17:\nCy, Ari ([age removed], he replaced Bex), Eli. Dov is [age removed], he can play. [age removed] fan watched. 5 goals in 2 years.",
    );
  });

  it("catches spelled-out and abbreviated ages, without touching ordinary numbers", () => {
    expect(
      redactReportText(
        "Ari (fifteen-year-old), Bex 14yo, Cy 16 y/o, Dov aged 13, Eli age: 12, Fay twenty-one years of age. Won 7 to 3 on page 15, played 2 years.",
      ),
    ).toBe(
      "Ari ([age removed]), Bex [age removed], Cy [age removed], Dov [age removed], Eli [age removed], Fay [age removed]. Won 7 to 3 on page 15, played 2 years.",
    );
  });
});
