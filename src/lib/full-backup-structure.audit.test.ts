import { expect, it } from "vitest";
import { validateBrowserPayload } from "./full-backup-contract";

const emptyBrowser = {
  "tkd-tournament": null,
  "tkd-tournament-categories": null,
  "tkd-category-deletions-v1": null,
  "tkd-retired-category-sources-v1": null,
};

it("rejects a structurally invalid current category even when its JSON version is valid", () => {
  expect(() =>
    validateBrowserPayload({
      ...emptyBrowser,
      "tkd-tournament": JSON.stringify({
        version: 1,
        state: { competitors: "not-an-array", phase: "setup" },
      }),
    })
  ).toThrow();
});

it("rejects a malformed archived category rather than restoring unusable history", () => {
  expect(() =>
    validateBrowserPayload({
      ...emptyBrowser,
      "tkd-tournament-categories": JSON.stringify({
        version: 2,
        categories: {},
        archives: { old: { categoryId: "old", replacementCategoryId: 7 } },
      }),
    })
  ).toThrow();
});
