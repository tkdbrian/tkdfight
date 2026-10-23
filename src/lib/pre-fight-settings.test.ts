import { describe, expect, it } from "vitest";
import { applyPreFightSettings, preFightTimingKind } from "./pre-fight-settings";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import type { FightEntry } from "@/store/tournament";
const fight: FightEntry = { id: "f", completed: false, red: {id:"a",name:"A"}, blue: {id:"b",name:"B"} };
describe("per-bout settings", () => {
  it("restricts two rounds to finals, including the final between RR groups", () => {
    expect(preFightTimingKind(fight, [])).toBe("regular");
    expect(preFightTimingKind({...fight,isFinalFight:true}, [])).toBe("elimination-final");
    expect(preFightTimingKind({...fight,isFinalFight:true,isTiebreakExtra:true}, [])).toBe("continuation");
    expect(preFightTimingKind({...fight,isGoldenPointFight:true}, [])).toBe("continuation");
  });
  it.each([40,60,90,120])("sets %s seconds preserving rest and base configuration", (seconds) => {
    const rules = baseline as RuleSetSparring;
    const actual = applyPreFightSettings(rules, String(seconds), 2, "elimination-final", "round-robin");
    expect(actual.rounds).toMatchObject({duration_seconds:seconds,count:2,rest_seconds:rules.rounds.rest_seconds});
    expect(rules.rounds.count).toBe(baseline.rounds.count);
  });
  it("keeps RR regular one round and never modifies continuation rules", () => {
    const rules=baseline as RuleSetSparring;
    expect(applyPreFightSettings(rules,null,null,"regular","round-robin").rounds.count).toBe(1);
    expect(applyPreFightSettings(rules,"40",2,"continuation","elimination")).toBe(rules);
    expect(() => applyPreFightSettings(rules,"0",null,"regular","elimination")).toThrow();
  });
});

it("restores exact legacy final round count without expanding selector options", () => {
 const rules=baseline as RuleSetSparring;
 expect(applyPreFightSettings(rules,null,3,"elimination-final","elimination").rounds.count).toBe(3);
});
