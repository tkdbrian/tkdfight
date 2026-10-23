import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreFightSettings } from "./PreFightSettings";
afterEach(cleanup);
it("offers shortcuts and final-only rounds without executing a save implicitly", () => {
  const onChange=vi.fn(); const onSave=vi.fn();
  render(<PreFightSettings seconds="60" rounds={1} allowRounds onChange={onChange} onReset={vi.fn()} onSave={onSave} dirty busy={false} disabled={false} whiteBand={false} inputId="test" />);
  fireEvent.click(screen.getByRole("button",{name:"1:30"}));
  expect(onChange).toHaveBeenCalledWith("90",1);
  fireEvent.click(screen.getByRole("button",{name:"2 rounds"}));
  expect(onChange).toHaveBeenCalledWith("60",2);
  expect(onSave).not.toHaveBeenCalled();
});
it("warns about exceptional band and blocks editing while saving", () => {
  render(<PreFightSettings seconds="120" rounds={1} allowRounds={false} onChange={vi.fn()} onReset={vi.fn()} dirty busy disabled={false} whiteBand inputId="test" />);
  expect(screen.getByRole("alert")).toHaveTextContent("40 segundos");
  expect(screen.queryByRole("button",{name:"2 rounds"})).toBeNull();
  expect(screen.getByRole("spinbutton")).toBeDisabled();
});

it("preserves legacy three-round defaults when changing only duration", () => {
  const onChange=vi.fn();
  render(<PreFightSettings seconds="60" rounds={3} allowRounds onChange={onChange} onReset={vi.fn()} dirty={false} busy={false} disabled={false} whiteBand={false} inputId="legacy" />);
  fireEvent.click(screen.getByRole("button",{name:"1:30"}));
  expect(onChange).toHaveBeenCalledWith("90",3);
});
