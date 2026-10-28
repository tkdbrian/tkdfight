import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DemoDeskState } from "../runtime/types";
import { DemoCategoryStrip } from "./DemoCategoryStrip";

const state = {
  categoryOrder: ["one", "two"], selectedCategoryId: "two",
  categories: {
    one: { config: { categoryName: "Infantiles", matchType: "sparring", mode: "round-robin" } },
    two: { config: { categoryName: "Infantiles", matchType: "tul", mode: "elimination" } },
  },
} as unknown as DemoDeskState;

it("uses the original desk's accessible category strip without mixing it with remote controls", () => {
  const onSelect = vi.fn();
  const onCreate = vi.fn();
  render(<DemoCategoryStrip state={state} readOnly={false} busy={false} onSelect={onSelect} onCreate={onCreate} />);
  const strip = screen.getByRole("region", { name: "Categorías del torneo" });
  const tabs = within(strip).getAllByRole("tab");
  expect(tabs).toHaveLength(2);
  expect(tabs[0]).toHaveTextContent("Infantiles (1)");
  expect(tabs[1]).toHaveTextContent("Infantiles (2)");
  expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  expect(tabs[0]).toHaveAttribute("aria-controls", "demo-category-panel");
  tabs[0].focus();
  fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
  expect(tabs[1]).toHaveFocus();
  fireEvent.keyDown(tabs[1], { key: "Home" });
  expect(tabs[0]).toHaveFocus();
  fireEvent.click(tabs[0]);
  fireEvent.click(within(strip).getByRole("button", { name: "Agregar categoría" }));
  expect(onSelect).toHaveBeenCalledWith("one");
  expect(onCreate).toHaveBeenCalledTimes(1);
});

it("keeps category navigation read-only in the second tab", () => {
  const onSelect = vi.fn();
  const onCreate = vi.fn();
  render(<DemoCategoryStrip state={state} readOnly busy={false} onSelect={onSelect} onCreate={onCreate} />);
  for (const tab of screen.getAllByRole("tab")) expect(tab).toBeDisabled();
  expect(screen.getByRole("button", { name: "Agregar categoría" })).toBeDisabled();
});
