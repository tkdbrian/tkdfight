import { describe, expect, it } from "vitest";
import { generateDoubleBracket, generateEliminationBracket, generateFinalFights, generateGroupsTournament } from "./bracket";
import { createCategoryPrintMetadata, createCategoryPrintReport, getCategoryPrintEligibility } from "./category-print";
import { GUP_GRADE_OPTIONS } from "./category-name";
import { AGE_DIVISIONS } from "./yusan-profile";
import { compareRoundRobinRank, preparePlayoffFights, resolveFirstPlace } from "./round-robin-resolution";
import type { CompetitorEntry, TournamentCategorySnapshot } from "@/store/tournament";

function entrants(count: number): CompetitorEntry[] {
  return Array.from({ length: count }, (_, i) => ({ id: `c${String(i).padStart(3,"0")}`, name: `Nombre ${i} Álvarez <script>`, team: "Club & TKD" }));
}
function base(competitors: CompetitorEntry[], mode: "elimination" | "round-robin"): TournamentCategorySnapshot {
  return { config: { id: "category", categoryName: "Adultos", tournamentName: "Evento real", tableChief: "Brian", judgesCount: 4,
    ruleSet: null, mode, matchType: "sparring" }, phase: "fighting", competitors, fights: [], groups: [], bracketMatches: [], bracketSeeds: [], currentFightIndex: 0, setupStarted: true };
}
function elimination(size: number, double = false): TournamentCategorySnapshot {
  const competitors = entrants(size); const result = base(competitors,"elimination");
  const generated = double ? generateDoubleBracket(competitors) : generateEliminationBracket(competitors);
  result.bracketMatches = generated.matches; result.bracketSeeds = generated.seeds;
  for (const match of [...result.bracketMatches].sort((a,b) => a.round-b.round)) {
    if (!match.completed && match.red.competitor && match.blue.competitor) {
      result.fights.push({ id: `fight-${match.id}`, red: match.red.competitor, blue: match.blue.competitor, completed: true, winner: "red", bracketMatchId: match.id, flagsRed: 4, flagsBlue: 0 });
      match.completed = true; match.winnerId = match.red.competitor.id;
    }
    const winner = competitors.find((entry) => entry.id === match.winnerId);
    for (const next of result.bracketMatches) {
      if (next.red.fromMatchId === match.id && winner) next.red.competitor = winner;
      if (next.blue.fromMatchId === match.id && winner) next.blue.competitor = winner;
    }
  }
  if (double) {
    const a = result.bracketMatches.filter((m) => m.bracketGroup === "A").at(-1)!;
    const b = result.bracketMatches.filter((m) => m.bracketGroup === "B").at(-1)!;
    result.fights.push({ id: "final-ab", groupId: "FINAL_AB", isFinalFight: true, completed: true, winner: "blue",
      red: competitors.find((c) => c.id === a.winnerId)!, blue: competitors.find((c) => c.id === b.winnerId)!, flagsRed: 1, flagsBlue: 3 });
  }
  return result;
}
function roundRobin(size: number): TournamentCategorySnapshot {
  const competitors = entrants(size); const result = base(competitors,"round-robin");
  const generated = generateGroupsTournament(competitors); result.groups = generated.groups;
  result.fights = generated.fights.map((f) => ({ ...f, completed: true, winner: f.red.id < f.blue.id ? "red" : "blue", flagsRed: f.red.id < f.blue.id ? 4 : 0, flagsBlue: f.red.id < f.blue.id ? 0 : 4,
    foulsRed: 0, foulsBlue: 0, warningsRed: 0, warningsBlue: 0 }));
  if (generated.groups.length > 1) {
    const winners = generated.groups.map((g) => [...g.competitors].sort((a,b) => a.id.localeCompare(b.id))[0]);
    result.fights.push(...generateFinalFights(winners).map((f) => ({ ...f, completed: true, winner: "blue" as const, flagsRed: 1, flagsBlue: 3 })));
  }
  return result;
}
function verified(snapshot: TournamentCategorySnapshot) {
  return { categoryId: snapshot.config.id, verified: true, confirmedResultIds: snapshot.fights.map((fight) => fight.id), tatami: "T1" };
}
const date = new Date("2026-10-25T12:00:00.000Z");

describe("structured print category metadata", () => {
  it.each(GUP_GRADE_OPTIONS)("prints only the selected real GUP band %s", (gupBand) => {
    const config = {...base([],"elimination").config,gradeSystem:"GUPS" as const,gupBand};
    expect(createCategoryPrintMetadata(config).grade).toBe(`GUPS · ${gupBand}`);
  });
  it.each([[1,1,"1 Dan"],[1,3,"1-3 Dan"],[3,10,"3-10 Dan"],[10,10,"10 Dan"]] as const)("prints full numeric DAN range %i-%i", (danFrom,danTo,grade) => {
    expect(createCategoryPrintMetadata({...base([],"elimination").config,gradeSystem:"DAN",danFrom,danTo}).grade).toBe(grade);
  });
  it.each([[0,1],[3,1],[1.5,3],[1,NaN],[1,Infinity],[1,Number.MAX_SAFE_INTEGER+1]])("does not invent malformed DAN grades %i-%i", (danFrom,danTo) => {
    expect(createCategoryPrintMetadata({...base([],"elimination").config,gradeSystem:"DAN",danFrom,danTo}).grade).toBeNull();
  });
  it.each(AGE_DIVISIONS)("uses the actual legacy known age division $id", (division) => {
    const metadata=createCategoryPrintMetadata({...base([],"elimination").config,ageDivision:division.id});
    expect(metadata.age).toBe(division.to === undefined ? `${division.from}+ años` : `${division.from}-${division.to} años`);
  });
  it("prioritizes custom ages and handles a single age or an open-ended band", () => {
    const config={...base([],"elimination").config,ageDivision:"kids" as const,categoryAgeFrom:"12",categoryAgeTo:"19"};
    expect(createCategoryPrintMetadata(config).age).toBe("12-19 años");
    expect(createCategoryPrintMetadata({...config,categoryAgeTo:"12"}).age).toBe("12 años");
    expect(createCategoryPrintMetadata({...config,categoryAgeOpenEnded:true}).age).toBe("12+ años");
    expect(createCategoryPrintMetadata({...config,categoryAgeFrom:"",categoryAgeTo:""}).age).toBe("3-5 años");
  });
  it.each([["12x","19"],["19","12"],["-1","12"],["1.5","12"],["","12"],["12",""]])("leaves malformed custom age %s-%s blank, without stale division fallback", (categoryAgeFrom,categoryAgeTo) => {
    expect(createCategoryPrintMetadata({...base([],"elimination").config,ageDivision:"kids",categoryAgeFrom,categoryAgeTo}).age).toBeNull();
  });
  it.each(["Masculino","Femenino","Mixto"] as const)("prints selected sex %s, discipline and weight", (sexDivision) => {
    const metadata=createCategoryPrintMetadata({...base([],"elimination").config,matchType:"tul",sexDivision,weightLabel:" Mediano A "});
    expect(metadata).toMatchObject({discipline:"Formas",sex:sexDivision,weight:null});
    expect(createCategoryPrintMetadata({...base([],"elimination").config,weightLabel:" Mediano A "}).weight).toBe("Mediano A");
  });
  it("never infers structured dimensions from a contradictory free category name", () => {
    const config=base([],"elimination").config;
    config.categoryName="Femenino · 10 Dan · 46+ años · Pesado C";
    expect(createCategoryPrintMetadata(config)).toEqual({discipline:"Lucha",grade:null,age:null,sex:null,weight:null});
    const snapshot={...elimination(2),config};
    const report=createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    expect(report.categoryMetadata).toEqual(createCategoryPrintMetadata(config));
    expect(report.title).toBe(config.categoryName);
  });
  it("keeps all nine age divisions, three sexes, both grade systems and both disciplines independent", () => {
    for (const ageDivision of AGE_DIVISIONS) for (const sexDivision of ["Masculino","Femenino","Mixto"] as const)
      for (const gradeSystem of ["GUPS","DAN"] as const) for (const matchType of ["sparring","tul"] as const) {
        const config={...base([],"elimination").config,ageDivision:ageDivision.id,sexDivision,gradeSystem,matchType,
          gupBand:GUP_GRADE_OPTIONS[1],danFrom:1,danTo:10};
        const metadata=createCategoryPrintMetadata(config);
        expect(metadata.age).toBe(ageDivision.to === undefined ? `${ageDivision.from}+ años` : `${ageDivision.from}-${ageDivision.to} años`);
        expect(metadata.sex).toBe(sexDivision);
        expect(metadata.grade).toBe(gradeSystem === "GUPS" ? `GUPS · ${GUP_GRADE_OPTIONS[1]}` : "1-10 Dan");
        expect(metadata.discipline).toBe(matchType === "tul" ? "Formas" : "Lucha");
      }
  });
});

describe("pure verified category print reports", () => {
  it.each([2,3,9,16])("keeps the entire %i-entry classic tree on one sheet with the final and no duplicate final appendix", (size) => {
    const snapshot = elimination(size);
    const report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    expect(report.classicSheets).toHaveLength(1);
    const sheet = report.classicSheets![0];
    expect(sheet.inputSlots).toBeLessThanOrEqual(16);
    expect(sheet.rounds).toHaveLength(Math.log2(sheet.inputSlots));
    expect(sheet.rounds.flatMap((round) => round.matches).map((match) => match.id)).toEqual(snapshot.bracketMatches.map((match) => match.id));
    expect(sheet.rounds.at(-1)!.matches[0].winnerId).toBe(report.champion.id);
    expect(report.classicExtras).toEqual([]);
    expect(report.details.map((fight) => fight.id)).toEqual(snapshot.fights.map((fight) => fight.id));
    expect(report.tableChief).toBe("Brian");
  });
  it.each([32,64,128])("splits %i classic entries only at sixteen-input subtrees and retains all references", (size) => {
    const snapshot = elimination(size), report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    const sheets = report.classicSheets!;
    const matches = sheets.flatMap((sheet) => sheet.rounds.flatMap((round) => round.matches));
    expect(sheets).toHaveLength(size / 16 + 1);
    expect(sheets.every((sheet) => sheet.inputSlots <= 16 && sheet.rounds.length <= 4)).toBe(true);
    expect(new Set(matches.map((match) => match.id))).toEqual(new Set(snapshot.bracketMatches.map((match) => match.id)));
    expect(matches).toHaveLength(snapshot.bracketMatches.length);
    const ids = new Set(sheets.map((sheet) => sheet.id));
    for (const match of matches) {
      if (match.nextPanelId) expect(ids.has(match.nextPanelId)).toBe(true);
      for (const slot of [match.red,match.blue]) if (slot.sourcePanelId) expect(ids.has(slot.sourcePanelId)).toBe(true);
    }
  });
  it("keeps full duplicate-name identities and clubs in a numbered roster, not diagram paragraphs", () => {
    const snapshot = elimination(16);
    for (const entry of snapshot.competitors) { entry.name = "Apellido largo ".repeat(20); entry.team = "Club".repeat(27); }
    const report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    const sheet = report.classicSheets![0];
    expect(sheet.roster).toHaveLength(16);
    expect(new Set(sheet.roster.map((entry) => entry.entryNumber)).size).toBe(16);
    expect(sheet.roster.every((entry) => entry.name === "Apellido largo ".repeat(20) && entry.club === "Club".repeat(27))).toBe(true);
    const inputs = sheet.rounds[0].matches.flatMap((match) => [match.red,match.blue]);
    expect(new Set(inputs.map((slot) => slot.inputPosition)).size).toBe(16);
    expect(inputs.map((slot) => slot.inputPosition)).toEqual(Array.from({length:16},(_,index) => index + 1));
    for (const slot of inputs) {
      expect(slot.club).toBeUndefined();
      expect(sheet.roster.find((entry) => entry.id === slot.competitorId)?.entryNumber).toBe(slot.entryNumber);
    }
    expect(Object.isFrozen(sheet.roster)).toBe(true);
  });
  it("prints separate complete A/B sheets and a linked two-slot actual final sheet", () => {
    const snapshot = elimination(18,true), report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    const sheets = report.classicSheets!;
    expect(sheets).toHaveLength(3);
    expect(sheets.map((sheet) => sheet.group)).toEqual(["A","B",null]);
    const final = sheets[2]; expect(final.isInterGroupFinal).toBe(true); expect(final.inputSlots).toBe(2);
    const match = final.rounds[0].matches[0];
    expect(match.id).toBe("final-ab"); expect(match.winnerId).toBe(report.champion.id);
    expect(match.red.sourcePanelId).toBe(sheets[0].id); expect(match.blue.sourcePanelId).toBe(sheets[1].id);
    expect(report.classicExtras).toEqual([]);
  });
  it("does not treat results phase or an unconfirmed draw as a completed category", () => {
    const snapshot = elimination(2); snapshot.phase = "results"; snapshot.fights[0].winner = "draw";
    expect(createCategoryPrintReport(snapshot, verified(snapshot), date)).toBeNull();
    const complete = elimination(2);
    expect(createCategoryPrintReport(complete, { ...verified(complete), verified: false }, date)).toBeNull();
    expect(createCategoryPrintReport(complete, { ...verified(complete), confirmedResultIds: [] }, date)).toBeNull();
    expect(createCategoryPrintReport(complete, { ...verified(complete), categoryId: "other" }, date)).toBeNull();
    expect(getCategoryPrintEligibility(complete, { ...verified(complete), verified: false }).requiredResultIds).toHaveLength(1);
  });
  it("prints detached metadata, safe literal names and no fabricated third place", () => {
    const snapshot = elimination(3); const original = JSON.stringify(snapshot);
    const report = createCategoryPrintReport(snapshot, verified(snapshot), date)!;
    expect(report.title).toBe("Adultos"); expect(report.eventName).toBe("Evento real"); expect(report.tatami).toBe("T1");
    expect(report.generatedAt).toBe(date.toISOString()); expect(report.discipline).toBe("Sparring");
    expect(report.champion.name).toContain("<script>"); expect(report).not.toHaveProperty("thirdPlace");
    expect(JSON.stringify(snapshot)).toBe(original);
    snapshot.config.categoryName = "Changed"; snapshot.competitors[0].name = "Changed";
    expect(report.title).toBe("Adultos"); expect(report.champion.name).not.toBe("Changed"); expect(Object.isFrozen(report)).toBe(true);
    expect(report.panels.flatMap((p) => p.rounds.flatMap((r) => r.matches)).some((m) => m.isBye)).toBe(true);
  });
  it("keeps RR tables per group and never credits the final or extras as regular points", () => {
    const snapshot = roundRobin(6); const report = createCategoryPrintReport(snapshot, verified(snapshot), date)!;
    expect(report.groups).toHaveLength(2); expect(report.groups.map((g) => g.rows[0].points)).toEqual([6,6]);
    expect(report.champion.id).toBe(snapshot.fights.at(-1)!.blue.id);
    expect(report.appendix.some((fight) => fight.label.includes("Final"))).toBe(true);
    expect(report.panels).toHaveLength(0);
  });
  it.each([2,3,8,16,32,64,128])("paginates %i elimination entrants without shrinking or duplicating matches", (size) => {
    const snapshot = elimination(size); const report = createCategoryPrintReport(snapshot, verified(snapshot), date)!;
    expect(report).not.toBeNull();
    expect(report.panels.every((p) => p.inputSlots <= 4)).toBe(true);
    const printed = report.panels.flatMap((p) => p.rounds.flatMap((r) => r.matches));
    expect(printed).toHaveLength(snapshot.bracketMatches.length);
    expect(new Set(printed.map((m) => m.id)).size).toBe(printed.length);
    const ids = new Set(report.panels.map((p) => p.id));
    for (const match of printed) {
      if (match.nextPanelId) expect(ids.has(match.nextPanelId)).toBe(true);
      for (const slot of [match.red,match.blue]) if (slot.sourcePanelId) expect(ids.has(slot.sourcePanelId)).toBe(true);
    }
  });
  it("prints separate A/B trees and the actual decisive final", () => {
    const snapshot = elimination(18,true); const report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    expect(new Set(report.panels.map((p) => p.group))).toEqual(new Set(["A","B"]));
    expect(report.champion.id).toBe(snapshot.fights.at(-1)!.blue.id); expect(report.runnerUp?.id).toBe(snapshot.fights.at(-1)!.red.id);
    expect(report.appendix.some((f) => f.id === "final-ab")).toBe(true);
  });
  it("uses at most four incoming slots for readable long-text paper panels", () => {
    const snapshot = elimination(32);
    for (const [index,entry] of snapshot.competitors.entries()) {
      entry.name = index % 2 ? `Apellido y nombre muy largo ${"Álvarez ".repeat(7)}` : "Corto";
      entry.team = "Club".repeat(27);
    }
    const report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    expect(report.panels.every((panel) => panel.inputSlots <= 4)).toBe(true);
    expect(report.panels.flatMap((panel) => panel.rounds.flatMap((round) => round.matches))).toHaveLength(snapshot.bracketMatches.length);
    expect(report.panels.flatMap((panel) => panel.rounds.flatMap((round) => round.matches)).some((match) => match.red.club === "Club".repeat(27))).toBe(true);
  });
  it("keeps every human BYE reference unique without labelling it as a played fight", () => {
    const snapshot = elimination(9); const report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    const matches = report.panels.flatMap((panel) => panel.rounds.flatMap((round) => round.matches));
    const byes = matches.filter((match) => match.isBye);
    expect(byes.length).toBeGreaterThan(1);
    expect(new Set(byes.map((match) => match.label)).size).toBe(byes.length);
    expect(byes.every((match) => match.label.includes("sin combate") && !match.label.startsWith("Combate"))).toBe(true);
    const classic = report.classicSheets!.flatMap((sheet) => sheet.rounds.flatMap((round) => round.matches));
    expect(new Set(classic.map((match) => match.label)).size).toBe(classic.length);
    expect(classic.every((match) => /^Cruce \d+$/.test(match.label))).toBe(true);
    expect(classic.filter((match) => match.isBye)).toHaveLength(byes.length);
  });
  it("keeps elimination drawn-final, timed extra and Golden Point distinct without a false champion", () => {
    const snapshot = elimination(2), original = snapshot.fights[0]; original.winner = "draw";
    const extra = { ...original, id: "timed-extra", isTiebreakExtra: true, continuationParentFightId: original.id };
    snapshot.fights.push(extra);
    snapshot.bracketMatches[0].winnerId = original.blue.id;
    expect(createCategoryPrintReport(snapshot,verified(snapshot),date)).toBeNull();
    snapshot.fights.push({ ...original, id: "golden", isGoldenPointFight: true, winner: "blue", continuationParentFightId: extra.id });
    const report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    expect(report.champion.id).toBe(original.blue.id);
    expect(report.appendix.map((fight) => fight.label)).toEqual(["Final de llave", "Desempate", "Punto de Oro"]);
    expect(report.classicExtras!.map((fight) => fight.id)).toEqual(["timed-extra","golden"]);
    expect(report.classicSheets![0].rounds[0].matches[0].winnerId).toBe(original.blue.id);
    expect(report.details.map((fight) => fight.id)).toEqual([original.id]);
  });
  it("uses official replay ordering while leaving the original RR statistics unchanged", () => {
    const snapshot = roundRobin(3);
    snapshot.fights = snapshot.fights.map((fight) => ({ ...fight, winner: "draw", flagsRed: 2, flagsBlue: 2 }));
    const rows = snapshot.competitors.map((entry) => ({ id: entry.id, points: 2, flagsFor: 4, foulsAgainst: 0, warnings: 0 }));
    const resolution = resolveFirstPlace("G1",rows,snapshot.fights,snapshot.competitors.map((entry) => entry.id));
    const extra = preparePlayoffFights(snapshot.competitors,"G1",resolution,60);
    snapshot.fights.push(...extra.map((fight) => ({ ...fight, completed: true, winner: fight.red.id > fight.blue.id ? "red" as const : "blue" as const,
      flagsRed: fight.red.id > fight.blue.id ? 4 : 0, flagsBlue: fight.red.id > fight.blue.id ? 0 : 4 })));
    const report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    expect(report.champion.id).toBe("c002");
    expect(report.groups[0].rows.map((row) => row.id)).toEqual(["c002","c001","c000"]);
    expect(report.groups[0].rows.every((row) => row.points === 2 && row.flagsFor === 4 && row.played === 2)).toBe(true);
    expect(report.appendix).toHaveLength(3);
  });
  it("reuses canonical flag / penalty / warning rank comparison", () => {
    const tied = { id: "a", points: 4, flagsFor: 6, foulsAgainst: 0, warnings: 0 };
    expect(compareRoundRobinRank(tied,{ ...tied, id: "b", flagsFor: 5 })).toBeLessThan(0);
    expect(compareRoundRobinRank(tied,{ ...tied, id: "b", foulsAgainst: 1 })).toBeLessThan(0);
    expect(compareRoundRobinRank(tied,{ ...tied, id: "b", warnings: 1 })).toBeLessThan(0);
  });
  it("requires the full direct RR tie sequence and appends Golden Point without changing its table", () => {
    const snapshot = roundRobin(3);
    snapshot.fights = snapshot.fights.map((fight) => {
      const leaders = [fight.red.id,fight.blue.id].every((id) => id !== "c002");
      return leaders ? { ...fight,winner: "draw",flagsRed:2,flagsBlue:2 } : fight;
    });
    const rows = snapshot.competitors.map((entry) => ({ id: entry.id, points: entry.id === "c002" ? 0 : 4, flagsFor: entry.id === "c002" ? 0 : 6, foulsAgainst: 0, warnings: 0 }));
    for (let attempt=0;attempt<2;attempt++) {
      const stage = resolveFirstPlace("G1",rows,snapshot.fights,snapshot.competitors.map((entry) => entry.id));
      const next = preparePlayoffFights(snapshot.competitors.filter((entry) => stage.nextIds.includes(entry.id)),"G1",stage,60);
      expect(next).toHaveLength(1);
      snapshot.fights.push({ ...next[0],completed:true,winner:"draw",flagsRed:2,flagsBlue:2 });
    }
    expect(createCategoryPrintReport(snapshot,verified(snapshot),date)).toBeNull();
    const stage = resolveFirstPlace("G1",rows,snapshot.fights,snapshot.competitors.map((entry) => entry.id));
    const [golden] = preparePlayoffFights(snapshot.competitors.filter((entry) => stage.nextIds.includes(entry.id)),"G1",stage,60);
    expect(golden.isGoldenPointFight).toBe(true);
    snapshot.fights.push({ ...golden,completed:true,winner:"blue",flagsRed:1,flagsBlue:3 });
    const report = createCategoryPrintReport(snapshot,verified(snapshot),date)!;
    expect(report.champion.id).toBe(golden.blue.id);
    expect(report.groups[0].rows.slice(0,2).every((row) => row.points === 4 && row.flagsFor === 6 && row.played === 2)).toBe(true);
    expect(report.appendix).toHaveLength(3);
  });
});
