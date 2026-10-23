import { randomUUID, timingSafeEqual } from "node:crypto";

export function isBackupPeerAllowed(
  address: string | undefined,
  host: string | undefined,
  origin: string | undefined,
  port: number
): boolean {
  if (address !== "::1" && address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") return false;
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return false;
  return origin === `http://${host}`;
}

export class BackupLease {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 10 * 60 * 1000
  ) {}

  get active(): boolean {
    if (this.token !== null && this.now() >= this.expiresAt) this.token = null;
    return this.token !== null;
  }

  begin(): string {
    if (this.active) throw new Error("Backup maintenance already active");
    this.token = randomUUID();
    this.expiresAt = this.now() + this.timeoutMs;
    return this.token;
  }

  matches(candidate: string | undefined): boolean {
    if (!candidate || !this.active || !this.token) return false;
    const left = Buffer.from(candidate);
    const right = Buffer.from(this.token);
    const matches = left.length === right.length && timingSafeEqual(left, right);
    if (matches) this.expiresAt = this.now() + this.timeoutMs;
    return matches;
  }

  end(candidate: string): void {
    if (!this.matches(candidate)) throw new Error("Backup maintenance lease mismatch");
    this.token = null;
  }
}
