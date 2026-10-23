export function verifyBuildIdentity(
  serverBuildId: string | null,
  indexBuildId: string | null,
  release: boolean
): void {
  if (!release && serverBuildId === null && indexBuildId === null) return;
  if (!serverBuildId || !indexBuildId || serverBuildId !== indexBuildId)
    throw new Error(
      "La compilación de esta pestaña no coincide con el servidor; cierre pestañas y limpie caché"
    );
}

export function indexBuildId(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="tkd-build-id"]')?.content ?? null;
}
