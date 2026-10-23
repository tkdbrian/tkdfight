export function decideBackupBoot(
  pathname: string,
  pendingClientMarker: boolean,
  serverMaintenanceRequired: boolean
): "normal" | "maintenance" {
  return pathname === "/maintenance" || pendingClientMarker || serverMaintenanceRequired
    ? "maintenance"
    : "normal";
}
