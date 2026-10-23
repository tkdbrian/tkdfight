import { beforeEach, describe, expect, it } from "vitest";
import type { FightEntry } from "@/store/tournament";
import { clearFightProposal, getOrCreateFightProposal } from "./pending-fight-proposals";

const red = { id: "red", name: "Rojo" };
const blue = { id: "blue", name: "Azul" };

function proposal(id: string, seconds = 60): FightEntry[] {
  return [
    {
      id,
      red,
      blue,
      completed: false,
      groupId: "G1",
      isTiebreakExtra: true,
      playoffKind: "direct",
      playoffBasis: "closed-regular-group",
      tiebreakerSeconds: seconds,
    },
  ];
}

beforeEach(() => localStorage.clear());

describe("persisted fight proposals", () => {
  it("reuses the same IDs and original duration after a 409 or lost response", () => {
    const first = getOrCreateFightProposal("category", "first-place-stage", () =>
      proposal("first", 60)
    );
    expect(first[0].id).toBe("first");
    // A failed request leaves the proposal stored; retry must not create a second fight.
    const retry = getOrCreateFightProposal("category", "first-place-stage", () =>
      proposal("new", 40)
    );
    expect(retry[0].id).toBe("first");
    expect(retry[0].tiebreakerSeconds).toBe(60);
    clearFightProposal("category", "first-place-stage", retry);
    const later = getOrCreateFightProposal("category", "first-place-stage", () =>
      proposal("later")
    );
    expect(later[0].id).toBe("later");
  });

  it("keeps independent stages separate and fails closed on a changed matchup", () => {
    getOrCreateFightProposal("category", "group-one", () => proposal("g1"));
    expect(getOrCreateFightProposal("category", "group-two", () => proposal("g2"))[0].id).toBe(
      "g2"
    );
    expect(() =>
      getOrCreateFightProposal("category", "group-one", () => [
        {
          ...proposal("changed")[0],
          blue: { id: "other", name: "Otro" },
        },
      ])
    ).toThrow(/no se crearán peleas duplicadas/);
    expect(getOrCreateFightProposal("category", "group-one", () => proposal("retry"))[0].id).toBe(
      "g1"
    );
  });
});
