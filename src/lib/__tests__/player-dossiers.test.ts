import { describe, expect, it } from "vitest";
import { PLAYER_DOSSIERS, getPlayerDossier } from "../player-dossiers";

describe("player dossiers", () => {
  it("every entry points at a published claude.ai artifact and has a blurb + snapshot", () => {
    const entries = Object.entries(PLAYER_DOSSIERS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [canonicalId, dossier] of entries) {
      expect(canonicalId).toBeTruthy();
      expect(dossier.url).toMatch(/^https:\/\/claude\.ai\/(code\/artifact\/[0-9a-f-]+|artifact\/[A-Za-z0-9]+)$/);
      expect(dossier.blurb.trim().length).toBeGreaterThan(10);
      expect(dossier.snapshot.trim().length).toBeGreaterThan(0);
    }
  });

  it("getPlayerDossier returns the entry by canonicalId, or undefined", () => {
    expect(getPlayerDossier("auto-isaac")).toBe(PLAYER_DOSSIERS["auto-isaac"]);
    expect(getPlayerDossier("no-such-player")).toBeUndefined();
  });
});
