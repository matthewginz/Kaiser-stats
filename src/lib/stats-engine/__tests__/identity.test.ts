import { describe, expect, it } from "vitest";
import {
  createProvisionalIdentityFromEmail,
  findPlayerByEmail,
  isPlausiblePlayerName,
  isUnresolvedLoginStub,
  resolveOnboardingRosterName,
  resolvePlayerName,
  rosterDisplayName,
} from "../identity";
import type { OnboardingRosterCheckPlayer } from "../identity";
import type { PlayerIdentity } from "../types";

describe("createProvisionalIdentityFromEmail", () => {
  it("derives a deterministic slug canonicalId from the email", () => {
    const identity = createProvisionalIdentityFromEmail("Ari.Fox@Example.com");
    expect(identity.canonicalId).toBe("auto-ari-fox-example-com");
    expect(identity.status).toBe("provisional");
  });

  it("normalizes the email to lowercase for displayName and knownEmails", () => {
    const identity = createProvisionalIdentityFromEmail("Ari.Fox@Example.com");
    expect(identity.displayName).toBe("ari.fox@example.com");
    expect(identity.knownEmails).toEqual(["ari.fox@example.com"]);
  });

  it("produces the same canonicalId for the same email every time", () => {
    const a = createProvisionalIdentityFromEmail("new.player@example.com");
    const b = createProvisionalIdentityFromEmail("new.player@example.com");
    expect(a.canonicalId).toBe(b.canonicalId);
  });
});

describe("findPlayerByEmail", () => {
  const players: PlayerIdentity[] = [
    {
      canonicalId: "s001",
      displayName: "Ari Fox",
      aliases: [],
      knownEmails: ["ari.fox@example.com"],
      leagues: ["sunday"],
      status: "regular",
    },
  ];

  it("matches case-insensitively", () => {
    expect(findPlayerByEmail(players, "Ari.Fox@EXAMPLE.com")?.canonicalId).toBe("s001");
  });

  it("returns null when no player has that email", () => {
    expect(findPlayerByEmail(players, "nobody@example.com")).toBeNull();
  });
});

describe("resolvePlayerName", () => {
  it("matches report/spreadsheet text against rosterName, not the editable displayName", () => {
    const players: PlayerIdentity[] = [
      {
        canonicalId: "001b",
        displayName: "Matusha",
        rosterName: "Matthew",
        aliases: ["Matthiew", "Mathew"],
        knownEmails: ["matthewginzburg@gmail.com"],
        leagues: ["sunday"],
        status: "regular",
      },
    ];

    expect(resolvePlayerName("Matthew", players).canonicalId).toBe("001b");
    expect(resolvePlayerName("Matthew", players).status).toBe("exact");
  });

  it("falls back to displayName for a player with no rosterName set yet", () => {
    const players: PlayerIdentity[] = [
      {
        canonicalId: "s001",
        displayName: "Ari Fox",
        aliases: [],
        knownEmails: [],
        leagues: ["sunday"],
        status: "regular",
      },
    ];

    expect(resolvePlayerName("Ari Fox", players).canonicalId).toBe("s001");
  });
});

describe("rosterDisplayName", () => {
  it("uses rosterName when set", () => {
    expect(rosterDisplayName({ displayName: "Matty", rosterName: "Matthew Rakov" })).toBe("Matthew Rakov");
  });

  it("falls back to displayName when rosterName is null", () => {
    expect(rosterDisplayName({ displayName: "Matty", rosterName: null })).toBe("Matty");
  });

  it("falls back to displayName when rosterName is undefined", () => {
    expect(rosterDisplayName({ displayName: "Matty" })).toBe("Matty");
  });

  it("falls back to displayName when rosterName is empty or whitespace", () => {
    expect(rosterDisplayName({ displayName: "Matty", rosterName: "" })).toBe("Matty");
    expect(rosterDisplayName({ displayName: "Matty", rosterName: "   " })).toBe("Matty");
  });
});

describe("isUnresolvedLoginStub", () => {
  it("is true for a provisional row with a known email and no roster name (an unresolved login stub)", () => {
    expect(
      isUnresolvedLoginStub({ status: "provisional", knownEmails: ["mikeginzburg@yahoo.com"], rosterName: null }),
    ).toBe(true);
  });

  it("is false for a provisional row with NO known email (a genuinely new teammate, not a login stub)", () => {
    expect(isUnresolvedLoginStub({ status: "provisional", knownEmails: [], rosterName: null })).toBe(false);
  });

  it("is false once an admin has assigned the stub a real roster name", () => {
    expect(
      isUnresolvedLoginStub({
        status: "provisional",
        knownEmails: ["mikeginzburg@yahoo.com"],
        rosterName: "Mike Ginzburg",
      }),
    ).toBe(false);
  });

  it("is false for a regular (non-provisional) player regardless of email", () => {
    expect(isUnresolvedLoginStub({ status: "regular", knownEmails: ["ari.fox@example.com"], rosterName: null })).toBe(
      false,
    );
  });
});

describe("resolveOnboardingRosterName", () => {
  function historicalPlayer(overrides: Partial<OnboardingRosterCheckPlayer> = {}): OnboardingRosterCheckPlayer {
    return {
      canonicalId: "001b",
      displayName: "Matthew Rakov",
      aliases: [],
      knownEmails: [],
      leagues: ["sunday"],
      status: "regular",
      authUserId: null,
      ...overrides,
    };
  }

  it("merges into a headless historical row on an exact match, when the caller is a login stub", () => {
    const check = resolveOnboardingRosterName(
      "auto-newperson-example-com",
      "provisional",
      "Matthew Rakov",
      [historicalPlayer()],
    );
    expect(check).toEqual({ outcome: "merge", targetCanonicalId: "001b" });
  });

  it("rejects an exact match already claimed by another account", () => {
    const check = resolveOnboardingRosterName(
      "auto-newperson-example-com",
      "provisional",
      "Matthew Rakov",
      [historicalPlayer({ authUserId: "some-other-user-uuid" })],
    );
    expect(check.outcome).toBe("error");
  });

  it("rejects an exact match when the caller's own row isn't a login stub", () => {
    const check = resolveOnboardingRosterName("s001", "regular", "Matthew Rakov", [historicalPlayer()]);
    expect(check.outcome).toBe("error");
  });

  it("rejects a flagged (close-but-not-exact) match, surfacing the closest name", () => {
    const check = resolveOnboardingRosterName(
      "auto-newperson-example-com",
      "provisional",
      "Mathew Rakov",
      [historicalPlayer()],
    );
    expect(check.outcome).toBe("error");
    if (check.outcome === "error") expect(check.error).toContain("Matthew Rakov");
  });

  it("proceeds normally for a genuinely new name with no match at all", () => {
    const check = resolveOnboardingRosterName(
      "auto-newperson-example-com",
      "provisional",
      "Someone Brand New",
      [historicalPlayer()],
    );
    expect(check).toEqual({ outcome: "proceed" });
  });
});

describe("isPlausiblePlayerName", () => {
  it("accepts real-shaped names", () => {
    for (const name of ["Ari", "Sasha SI", "Oleg new Stas", "Mary-Kate", "O'Neil", "Dr. Bex"]) {
      expect(isPlausiblePlayerName(name), name).toBe(true);
    }
  });

  it("rejects notes, including ones with no spaces or digits that the slug would still turn into a long id", () => {
    for (const name of [
      "Dov 15 year old he replaced Eli",
      "Ari(fifteen-year-old-he-replaced-Bex)",
      "Ari-fifteen-year-old",
      "Ari fifteen",
      "Bex teen",
      "Ari fifteen",
      "Bex teen",
      "Dov, Eli",
      "Ari ２",
      "Женя",
      "",
      "Abcdefghijklmnopqrstuvwxyzabcdef",
    ]) {
      expect(isPlausiblePlayerName(name), name).toBe(false);
    }
  });
});
