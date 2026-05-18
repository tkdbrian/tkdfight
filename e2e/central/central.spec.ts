/**
 * E2E tests: Mesa Central UI.
 *
 * Prerequisites:
 *   T1 (Mesa Central app): $env:PORT="3001"; $env:DATA_DIR="./data-t1"; npx tsx server/index.ts
 *   T2 (tatami with fights): $env:PORT="3002"; $env:DATA_DIR="./data-t2"; npx tsx server/index.ts
 *
 * The tests add localhost:3002 as a tatami target from the UI, then verify that:
 *  1. The page loads without JS errors.
 *  2. Cross-origin fetch to T2 is NOT blocked by CORS (the root cause of the original bug).
 *  3. After the queue poll cycle, fights appear instead of "Sin peleas pendientes".
 */
import { test, expect, type Page } from "@playwright/test";
import { CentralPage } from "./central-page";

const T1_BASE = "http://localhost:3001";
const T2_IP = "localhost";
const T2_PORT = 3002;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Seed a fight in T2 via sync-fights so the queue is never empty running these tests. */
async function seedFightInT2() {
  await fetch(`http://${T2_IP}:${T2_PORT}/api/ring/sync-fights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      competitors: [
        { id: "e2e-c1", name: "Ana García", weight: null, belt: null, team: null },
        { id: "e2e-c2", name: "Luis Martínez", weight: null, belt: null, team: null },
      ],
      fights: [
        {
          id: "e2e-f1",
          red: { id: "e2e-c1", name: "Ana García" },
          blue: { id: "e2e-c2", name: "Luis Martínez" },
          category: "E2E Categoría",
          completed: false,
          winner: null,
          reason: null,
          round_index: null,
          group_id: null,
        },
      ],
    }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Mesa Central — carga inicial", () => {
  test("la página carga sin errores JS en consola", async ({ page }) => {
    const jsErrors: string[] = [];
    page.on("pageerror", (err) => jsErrors.push(err.message));

    const central = new CentralPage(page);
    await central.goto();

    await expect(central.heading).toBeVisible();
    expect(jsErrors).toHaveLength(0);
  });

  test("muestra el campo para agregar IP de tatami", async ({ page }) => {
    const central = new CentralPage(page);
    await central.goto();

    await expect(central.ipInput).toBeVisible();
    await expect(central.portInput).toBeVisible();
  });
});

test.describe("Mesa Central — CORS: fetch cross-origin no es bloqueado", () => {
  test("fetch desde browser a T2 /api/ring/queue no lanza error CORS", async ({ page }) => {
    await page.goto(T1_BASE + "/central");

    // Execute fetch cross-origin (localhost:3001 → localhost:3002) inside the browser
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const data = await res.json();
        return { ok: true, isArray: Array.isArray(data), length: data.length };
      } catch (e) {
        return { error: String(e) };
      }
    }, `http://${T2_IP}:${T2_PORT}/api/ring/queue`);

    // If CORS is missing, the error contains "Failed to fetch" / "CORS"
    expect(result).not.toHaveProperty("error");
    expect((result as { ok: boolean }).ok).toBe(true);
    expect((result as { isArray: boolean }).isArray).toBe(true);
  });
});

test.describe("Mesa Central — queue muestra peleas pendientes", () => {
  test.beforeAll(async () => {
    // Ensure T2 has at least one fight in the queue
    await seedFightInT2();
  });

  test("después de conectar T2 NO aparece 'Sin peleas pendientes'", async ({ page }) => {
    const central = new CentralPage(page);
    await central.goto();

    // Add T2 as a tatami target
    await central.addTatami(T2_IP, T2_PORT);

    // Wait one full poll cycle so the queue is fetched
    await central.waitForQueuePoll();

    // "Sin peleas pendientes" must NOT appear anywhere on the page
    await expect(central.noPendingFightsText).not.toBeVisible();
  });

  test("después de conectar T2 aparece la sección de próximas peleas con competidores", async ({ page }) => {
    const central = new CentralPage(page);
    await central.goto();

    await central.addTatami(T2_IP, T2_PORT);
    await central.waitForQueuePoll();

    // The "PRÓXIMAS PELEAS" heading appears when pendingCount > 0
    await expect(page.getByText(/próximas peleas/i)).toBeVisible();

    // At least one competitor name row must be in the card
    // (any text in the fight list that is NOT the heading or status)
    await expect(page.getByText(/siguiente|en cola/i).first()).toBeVisible();
  });
});
