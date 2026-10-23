import type { TournamentMode } from "@/store/tournament";

/** Menu visibility and route guards always follow the locally selected category. */
export function isCategoryFormatRouteAvailable(pathname: string, mode: TournamentMode): boolean {
  const route = pathname.replace(/\/+$/, "") || "/";
  if (route === "/bracket") return mode === "elimination";
  if (route === "/standings") return mode !== "elimination";
  return true;
}
