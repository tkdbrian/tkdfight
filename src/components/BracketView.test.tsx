import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEliminationBracket } from "@/lib/bracket";
import { BracketView } from "./BracketView";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("bye reseeding controls", () => {
  it("includes both sides of an automatic first-round bye as drag/drop slots", () => {
    const competitors = ["Pedro", "Juan", "Cris"].map((name) => ({ id: name, name }));
    const { matches } = generateEliminationBracket(competitors);
    const view = render(<BracketView matches={matches} competitors={competitors} onSwap={vi.fn()} />);
    expect(view.container.querySelectorAll('rect[fill="transparent"]')).toHaveLength(4);
  });
  it("keeps a played match uneditable", () => {
    const competitors = ["Pedro", "Juan"].map((name) => ({ id: name, name }));
    const { matches } = generateEliminationBracket(competitors);
    const view = render(<BracketView matches={matches.map((m) => ({ ...m, completed: true, winnerId: "Pedro" }))} competitors={competitors} onSwap={vi.fn()} />);
    expect(view.container.querySelectorAll('rect[fill="transparent"]')).toHaveLength(0);
  });
  it.each([true, false])("supports the BYE competitor as drag source or destination (%s)", (byeIsSource) => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const competitors = ["Pedro", "Juan", "Cris"].map((name) => ({ id: name, name }));
    const { matches } = generateEliminationBracket(competitors);
    const onSwap = vi.fn();
    const view = render(<BracketView matches={matches} competitors={competitors} onSwap={onSwap} />);
    const svg = view.container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 647, bottom: 238, width: 647, height: 238, toJSON: () => ({}) });
    Object.defineProperty(svg, "setPointerCapture", { value: vi.fn() });
    const areas = view.container.querySelectorAll('rect[fill="transparent"]');
    const source = byeIsSource ? 2 : 0;
    const destination = byeIsSource ? 0 : 2;
    const sourceY = source === 2 ? 166 : 62;
    const destinationY = destination === 2 ? 166 : 62;
    fireEvent.pointerDown(areas[source], { clientX: 80, clientY: sourceY, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 80, clientY: destinationY, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 80, clientY: destinationY, pointerId: 1 });
    expect(onSwap).toHaveBeenCalledWith(matches[source === 2 ? 1 : 0].id, "red", matches[destination === 2 ? 1 : 0].id, "red");
  });
});
