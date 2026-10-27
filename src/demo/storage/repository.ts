/** Browser-only demo authority. Never shares the portable server's SQL or legacy localStorage keys. */
export const DEMO_DATABASE_NAME = "tkdfight-browser-desk-v2";
export const DEMO_BACKUP_FORMAT = "tkdfight-browser-desk";
export const DEMO_SCHEMA_VERSION = 2;

const STATE_STORE = "state";
const RECEIPTS_STORE = "receipts";
const LEASE_STORE = "lease";
const ACTIVE_KEY = "active";
const WRITER_KEY = "writer";
const LEASE_DURATION_MS = 12_000;
const LEASE_RENEW_MS = 4_000;
const RECLAIM_PROBE_MS = 500;
const TAB_KEY = "tkdfight-browser-desk-v2:tab-id";

export interface DemoCursor {
  generation: number;
  revision: number;
}

export interface DemoSnapshot<T> extends DemoCursor {
  schemaVersion: typeof DEMO_SCHEMA_VERSION;
  kind: "active";
  updatedAt: string;
  payload: T;
}

interface DemoTombstone extends DemoCursor {
  schemaVersion: typeof DEMO_SCHEMA_VERSION;
  kind: "deleted";
  updatedAt: string;
}

export interface DemoCommandReceipt extends DemoCursor {
  commandId: string;
  committedAt: string;
}

export interface DemoCommit<T> {
  applied: boolean;
  receipt: DemoCommandReceipt;
  snapshot: DemoSnapshot<T>;
}

export interface DemoBackup<T> {
  format: typeof DEMO_BACKUP_FORMAT;
  version: typeof DEMO_SCHEMA_VERSION;
  exportedAt: string;
  snapshot: DemoSnapshot<T>;
  receipts: DemoCommandReceipt[];
}

export interface DemoImportPreview<T> {
  /** Inspect this before presenting an explicit confirmation to replace the current demo. */
  backup: DemoBackup<T>;
  /** Import refuses to overwrite if anything changed after the preview. */
  currentCursor: DemoCursor;
  raw: string;
}

export interface DemoRepositoryOptions<T> {
  validatePayload: (value: unknown) => value is T;
  /** Return a new paused payload only when an interrupted active bout was running. */
  recoverPaused: (payload: T) => T | null;
  databaseName?: string;
  indexedDBFactory?: IDBFactory;
  now?: () => number;
}

export type DemoStorageErrorCode =
  | "unavailable"
  | "storage"
  | "quota"
  | "corrupt"
  | "invalid-backup"
  | "conflict"
  | "read-only";

export class DemoStorageError extends Error {
  constructor(
    readonly code: DemoStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DemoStorageError";
  }
}

interface WriterLease {
  ownerId: string;
  tabId?: string;
  expiresAt: number;
}

interface RevisionMessage {
  kind: "revision";
  source: string;
  revision: number;
}

interface ProbeMessage {
  kind: "probe";
  source: string;
  target: string;
  challenge: string;
}

interface AliveMessage {
  kind: "alive";
  source: string;
  target: string;
  challenge: string;
}

interface TakeoverMessage {
  kind: "takeover";
  source: string;
  target: string;
}

type DemoChannelMessage = RevisionMessage | ProbeMessage | AliveMessage | TakeoverMessage;

function tabIdentity(): string | null {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return null;
    const existing = storage.getItem(TAB_KEY);
    if (existing) return existing;
    const id = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random()}`;
    storage.setItem(TAB_KEY, id);
    return id;
  } catch { return null; }
}

const INITIAL_CURSOR: DemoCursor = { generation: 0, revision: -1 };

function validCursor(value: unknown): value is DemoCursor {
  return object(value) && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0 &&
    Number.isSafeInteger(value.revision) && (value.revision as number) >= -1;
}

function sameCursor(a: DemoCursor, b: DemoCursor): boolean {
  return a.generation === b.generation && a.revision === b.revision;
}

/** Capture the generation when an action is created; reuse this entire ID on retry. */
export function makeDemoCommandId(generation: number, nonce?: string): string {
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new DemoStorageError("conflict", "Generación de comando inválida.");
  const suffix = nonce ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  if (!suffix || /\s/.test(suffix)) throw new DemoStorageError("conflict", "Identificador de comando inválido.");
  return `g${generation}:${suffix}`;
}

function commandGeneration(commandId: string): number | null {
  const match = /^g(0|[1-9]\d*):([^\s]+)$/.exec(commandId);
  if (!match) return null;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) ? generation : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function storageFailure(error: unknown): DemoStorageError {
  if (error instanceof DemoStorageError) return error;
  const name = object(error) && typeof error.name === "string" ? error.name : "";
  if (name === "QuotaExceededError")
    return new DemoStorageError("quota", "No queda espacio para guardar la demo. Exportá un respaldo antes de continuar.", { cause: error });
  if (name === "VersionError")
    return new DemoStorageError("corrupt", "La demo pertenece a una versión de datos más nueva. No se modificó ni borró.", { cause: error });
  return new DemoStorageError("storage", "No se pudo guardar la demo en este navegador.", { cause: error });
}

function assertReceipt(value: unknown): asserts value is DemoCommandReceipt {
  if (!object(value) || typeof value.commandId !== "string" || !value.commandId ||
    !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 ||
    commandGeneration(value.commandId) !== value.generation ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    typeof value.committedAt !== "string" || !Number.isFinite(Date.parse(value.committedAt)))
    throw new DemoStorageError("corrupt", "El registro de operaciones de la demo está dañado. Exportá los datos disponibles; no se borrarán automáticamente.");
}

/** Rejects values that structured-clone could store but a portable JSON backup would lose. */
function jsonClone<T>(value: T): T {
  const seen = new Set<object>();
  function check(node: unknown): void {
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number" && Number.isFinite(node)) return;
    if (typeof node !== "object") throw new DemoStorageError("storage", "La demo contiene datos que no se pueden respaldar en JSON.");
    if (seen.has(node)) throw new DemoStorageError("storage", "La demo contiene referencias circulares.");
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null)
      throw new DemoStorageError("storage", "La demo contiene un objeto no compatible con respaldos JSON.");
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) check(child);
    } else {
      // Optional TypeScript fields are often present as `undefined`; JSON omits them.
      for (const child of Object.values(node)) if (child !== undefined) check(child);
    }
    seen.delete(node);
  }
  check(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export class DemoRepository<T> {
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private readonly ownerId = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random()}`;
  private readonly tabId = tabIdentity();
  private readonly name: string;
  private readonly factory: IDBFactory | undefined;
  private readonly now: () => number;
  private writer = false;
  private lifecycle = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private acquiring: Promise<boolean> | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  private readonly challenges = new Map<string, (alive: boolean) => void>();
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly onPageHide = () => {
    // Synchronous navigation marker; async IndexedDB cleanup is not reliable on unload.
    if (!this.writer || !this.tabId) return;
    try { globalThis.sessionStorage?.setItem(`${this.name}:retired-owner`, this.ownerId); }
    catch { /* Conservative expiry retry remains available. */ }
  };

  constructor(private readonly options: DemoRepositoryOptions<T>) {
    this.name = options.databaseName ?? DEMO_DATABASE_NAME;
    this.factory = options.indexedDBFactory ?? globalThis.indexedDB;
    this.now = options.now ?? Date.now;
    globalThis.addEventListener?.("pagehide", this.onPageHide);
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`${this.name}:revisions`);
      this.channel.onmessage = (event: MessageEvent<DemoChannelMessage>) => {
        const message = event.data;
        if (!object(message) || message.source === this.ownerId) return;
        if (message.kind === "revision" && Number.isSafeInteger(message.revision))
          this.notify(message.revision as number);
        if (message.kind === "probe" && message.target === this.ownerId && this.writer &&
          typeof message.challenge === "string") {
          try { this.channel?.postMessage({ kind: "alive", source: this.ownerId,
            target: message.source, challenge: message.challenge } satisfies AliveMessage); }
          catch { /* The lease check still fences writes. */ }
        }
        if (message.kind === "alive" && message.target === this.ownerId &&
          typeof message.challenge === "string") this.challenges.get(message.challenge)?.(true);
        if (message.kind === "takeover" && message.target === this.ownerId) {
          this.writer = false;
          if (this.renewal) { clearInterval(this.renewal); this.renewal = null; }
          void this.readCursor().then((cursor) => this.notify(cursor.revision)).catch(() => {});
        }
      };
    }
  }

  get isWriter(): boolean { return this.writer; }

  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(revision: number): void {
    // A view callback must never make an already committed IDB transaction look failed.
    for (const listener of this.listeners) {
      try { listener(revision); } catch { /* observer errors are not storage failures */ }
    }
  }

  private broadcast(revision: number): void {
    try { this.channel?.postMessage({ kind: "revision", source: this.ownerId, revision } satisfies RevisionMessage); }
    catch { /* IDB is authoritative even if this optional hint is unavailable. */ }
    this.notify(revision);
  }

  async open(): Promise<DemoSnapshot<T> | null> {
    await this.getDatabase();
    return this.read();
  }

  private async getDatabase(): Promise<IDBDatabase> {
    if (this.closed) throw new DemoStorageError("unavailable", "Esta instancia de la demo ya se cerró.");
    if (this.database) return this.database;
    if (this.opening) return this.opening;
    const factory = this.factory;
    if (!factory) throw new DemoStorageError("unavailable", "IndexedDB no está disponible en este navegador.");
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(this.name, DEMO_SCHEMA_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
        if (!db.objectStoreNames.contains(RECEIPTS_STORE)) db.createObjectStore(RECEIPTS_STORE);
        if (!db.objectStoreNames.contains(LEASE_STORE)) db.createObjectStore(LEASE_STORE);
      };
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
      request.onerror = () => reject(storageFailure(request.error));
      request.onblocked = () => {
        blocked = true;
        reject(new DemoStorageError("unavailable", "Otra pestaña mantiene abierta una versión anterior de la demo. Cerrala y reintentá."));
      };
    });
    let database: IDBDatabase;
    try { database = await this.opening; }
    finally { this.opening = null; }
    database.onversionchange = () => {
      this.writer = false;
      database.close();
      if (this.database === database) this.database = null;
    };
    this.database = database;
    return database;
  }

  private async transaction<R>(
    stores: string[], mode: IDBTransactionMode,
    work: (tx: IDBTransaction, result: (value: R) => void, fail: (error: unknown) => void) => void,
  ): Promise<R> {
    const database = await this.getDatabase();
    return new Promise<R>((resolve, reject) => {
      let value!: R;
      let failure: unknown;
      let tx: IDBTransaction;
      try { tx = database.transaction(stores, mode); }
      catch (error) { reject(storageFailure(error)); return; }
      const fail = (error: unknown) => {
        failure = error;
        try { tx.abort(); } catch { reject(storageFailure(error)); }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(storageFailure(failure ?? tx.error));
      tx.onerror = () => { /* onabort reports the final cause */ };
      try { work(tx, (next) => { value = next; }, fail); }
      catch (error) { fail(error); }
    });
  }

  private checkedRecord(value: unknown): DemoSnapshot<T> | DemoTombstone | null {
    if (value === undefined) return null;
    if (!object(value) || value.schemaVersion !== DEMO_SCHEMA_VERSION || !validCursor(value) ||
      typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
      (value.kind !== "deleted" && value.kind !== "active") ||
      (value.kind === "active" && ((value.revision as number) < 0 || !this.options.validatePayload(value.payload))))
      throw new DemoStorageError("corrupt", "Los datos de la demo están dañados o son incompatibles. No se borrarán automáticamente.");
    return value as unknown as DemoSnapshot<T> | DemoTombstone;
  }

  private cursorOf(record: DemoSnapshot<T> | DemoTombstone | null): DemoCursor {
    return record ? { generation: record.generation, revision: record.revision } : { ...INITIAL_CURSOR };
  }

  async read(): Promise<DemoSnapshot<T> | null> {
    return this.transaction<DemoSnapshot<T> | null>([STATE_STORE], "readonly", (tx, result, fail) => {
      const request = tx.objectStore(STATE_STORE).get(ACTIVE_KEY);
      request.onsuccess = () => {
        try {
          const record = this.checkedRecord(request.result);
          result(record?.kind === "active" ? record : null);
        }
        catch (error) { fail(error); }
      };
    });
  }

  /** Includes the persistent tombstone cursor after reset, when read() returns null. */
  async readCursor(): Promise<DemoCursor> {
    return this.transaction<DemoCursor>([STATE_STORE], "readonly", (tx, result, fail) => {
      const request = tx.objectStore(STATE_STORE).get(ACTIVE_KEY);
      request.onsuccess = () => {
        try { result(this.cursorOf(this.checkedRecord(request.result))); }
        catch (error) { fail(error); }
      };
    });
  }

  private async readLease(): Promise<WriterLease | null> {
    return this.transaction<WriterLease | null>([LEASE_STORE], "readonly", (tx, result) => {
      const request = tx.objectStore(LEASE_STORE).get(WRITER_KEY);
      request.onsuccess = () => result((request.result as WriterLease | undefined) ?? null);
    });
  }

  private async probeOwner(ownerId: string): Promise<boolean> {
    if (!this.channel) return false;
    const challenge = globalThis.crypto?.randomUUID?.() ?? `probe-${Date.now()}-${Math.random()}`;
    return new Promise<boolean>((resolve) => {
      const finish = (alive: boolean) => {
        clearTimeout(timeout);
        this.challenges.delete(challenge);
        resolve(alive);
      };
      const timeout = setTimeout(() => finish(false), RECLAIM_PROBE_MS);
      this.challenges.set(challenge, finish);
      try { this.channel?.postMessage({ kind: "probe", source: this.ownerId,
        target: ownerId, challenge } satisfies ProbeMessage); }
      catch { finish(false); }
    });
  }

  private retiredOwner(): string | null {
    try { return globalThis.sessionStorage?.getItem(`${this.name}:retired-owner`) ?? null; }
    catch { return null; }
  }

  private clearRetiredOwner(): void {
    try { globalThis.sessionStorage?.removeItem(`${this.name}:retired-owner`); }
    catch { /* Nonessential marker cleanup. */ }
  }

  private scheduleRetry(lease: WriterLease | null): void {
    if (this.retry || this.closed || this.closing || !lease) return;
    const sameTabToken = this.tabId && lease.tabId === this.tabId;
    const delay = Math.max(100, Math.min(sameTabToken ? 750 : LEASE_DURATION_MS,
      lease.expiresAt - this.now() + 30));
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.acquireWriter().then(async (acquired) => {
        if (acquired) this.notify((await this.readCursor()).revision);
      }).catch(() => { /* Explicit retry remains available. */ });
    }, delay);
  }

  /** A second tab may read and subscribe but cannot score until the active tab releases/expires. */
  async acquireWriter(): Promise<boolean> {
    if (this.closed || this.closing) return false;
    if (this.acquiring) return this.acquiring;
    const lifecycle = this.lifecycle;
    const acquisition = this.acquireWriterFor(lifecycle);
    this.acquiring = acquisition;
    try { return await acquisition; }
    finally { if (this.acquiring === acquisition) this.acquiring = null; }
  }

  private async acquireWriterFor(lifecycle: number): Promise<boolean> {
    const prior = await this.readLease();
    let reclaimOwner: string | null = null;
    if (prior && prior.ownerId !== this.ownerId && prior.expiresAt > this.now() &&
      this.tabId && prior.tabId === this.tabId && this.channel &&
      this.retiredOwner() === prior.ownerId) {
      // A pagehide marker proves navigation of this tab; an opener-cloned token alone does not.
      // The challenge also guards BFCache/resumed or cloned pages that might still be alive.
      if (!(await this.probeOwner(prior.ownerId))) reclaimOwner = prior.ownerId;
    }
    const acquired = await this.transaction<boolean>([LEASE_STORE], "readwrite", (tx, result, fail) => {
      const store = tx.objectStore(LEASE_STORE);
      const request = store.get(WRITER_KEY);
      request.onsuccess = () => {
        try {
          const lease = request.result as WriterLease | undefined;
          if (lease && lease.ownerId !== this.ownerId && lease.expiresAt > this.now() &&
            !(reclaimOwner === lease.ownerId && lease.tabId === this.tabId)) { result(false); return; }
          store.put({ ownerId: this.ownerId, tabId: this.tabId ?? undefined,
            expiresAt: this.now() + LEASE_DURATION_MS } satisfies WriterLease, WRITER_KEY);
          result(true);
        } catch (error) { fail(error); }
      };
    });
    if (!acquired) {
      this.writer = false;
      if (this.renewal) { clearInterval(this.renewal); this.renewal = null; }
      this.scheduleRetry(await this.readLease());
      return false;
    }
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.writer = true;
    this.clearRetiredOwner();
    if (reclaimOwner) {
      try { this.channel?.postMessage({ kind: "takeover", source: this.ownerId,
        target: reclaimOwner } satisfies TakeoverMessage); }
      catch { /* IDB lease ownership is authoritative. */ }
    }
    if (this.lifecycle !== lifecycle || this.closing) {
      await this.releaseWriter();
      return false;
    }
    this.startRenewal();
    try {
      const snapshot = await this.read();
      if (snapshot && this.lifecycle === lifecycle && !this.closing) {
        const paused = this.options.recoverPaused(snapshot.payload);
        if (paused !== null) await this.commit(
          { generation: snapshot.generation, revision: snapshot.revision },
          makeDemoCommandId(snapshot.generation, `recovery:pause:${snapshot.revision}`), paused,
        );
      }
    } catch (error) {
      await this.releaseWriter();
      throw error;
    }
    if (this.lifecycle !== lifecycle || this.closing) {
      await this.releaseWriter();
      return false;
    }
    return true;
  }

  private startRenewal(): void {
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = setInterval(() => {
      void this.renewWriter().catch(() => {
        this.writer = false;
        if (this.renewal) { clearInterval(this.renewal); this.renewal = null; }
      });
    }, LEASE_RENEW_MS);
  }

  async renewWriter(): Promise<boolean> {
    if (!this.writer) return false;
    const renewed = await this.transaction<boolean>([LEASE_STORE], "readwrite", (tx, result, fail) => {
      const store = tx.objectStore(LEASE_STORE);
      const request = store.get(WRITER_KEY);
      request.onsuccess = () => {
        try {
          const lease = request.result as WriterLease | undefined;
          if (!lease || lease.ownerId !== this.ownerId || lease.expiresAt <= this.now()) { result(false); return; }
          store.put({ ownerId: this.ownerId, tabId: this.tabId ?? undefined,
            expiresAt: this.now() + LEASE_DURATION_MS } satisfies WriterLease, WRITER_KEY);
          result(true);
        } catch (error) { fail(error); }
      };
    });
    this.writer = renewed;
    if (!renewed && this.renewal) { clearInterval(this.renewal); this.renewal = null; }
    return renewed;
  }

  async releaseWriter(): Promise<void> {
    if (this.renewal) { clearInterval(this.renewal); this.renewal = null; }
    if (!this.writer) return;
    try {
      await this.transaction<void>([LEASE_STORE], "readwrite", (tx, result, fail) => {
        const store = tx.objectStore(LEASE_STORE);
        const request = store.get(WRITER_KEY);
        request.onsuccess = () => {
          try { if ((request.result as WriterLease | undefined)?.ownerId === this.ownerId) store.delete(WRITER_KEY); result(); }
          catch (error) { fail(error); }
        };
      });
    } finally { this.writer = false; }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.onPageHide();
    this.lifecycle += 1;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.closing = (async () => {
      try {
        // An acquisition that completes after cleanup must release its late lease.
        if (this.acquiring) await this.acquiring.catch(() => false);
        try { await this.releaseWriter(); }
        finally { if (this.opening) await this.opening.catch(() => undefined); }
      } finally {
        globalThis.removeEventListener?.("pagehide", this.onPageHide);
        for (const resolve of this.challenges.values()) resolve(false);
        this.challenges.clear();
        this.channel?.close();
        this.channel = null;
        this.database?.close();
        this.database = null;
        this.closed = true;
      }
    })();
    return this.closing;
  }

  private assertWriter(lease: WriterLease | undefined): void {
    if (!this.writer || !lease || lease.ownerId !== this.ownerId || lease.expiresAt <= this.now())
      throw new DemoStorageError("read-only", "Otra pestaña está operando esta demo. Esta pestaña es de solo lectura.");
  }

  async commit(expected: DemoCursor, commandId: string, nextPayload: T): Promise<DemoCommit<T>> {
    if (!validCursor(expected) || commandGeneration(commandId) !== expected.generation)
      throw new DemoStorageError("conflict", "Operación de demo inválida.");
    const payload = jsonClone(nextPayload);
    if (!this.options.validatePayload(payload))
      throw new DemoStorageError("storage", "La operación produjo datos de demo inválidos. No se guardó nada.");
    const result = await this.transaction<DemoCommit<T>>(
      [STATE_STORE, RECEIPTS_STORE, LEASE_STORE], "readwrite", (tx, done, fail) => {
        const leases = tx.objectStore(LEASE_STORE);
        const receipts = tx.objectStore(RECEIPTS_STORE);
        const states = tx.objectStore(STATE_STORE);
        const leaseRequest = leases.get(WRITER_KEY);
        leaseRequest.onsuccess = () => {
          try {
            this.assertWriter(leaseRequest.result as WriterLease | undefined);
            const receiptRequest = receipts.get(commandId);
            receiptRequest.onsuccess = () => {
              try {
                const existingReceipt = receiptRequest.result;
                if (existingReceipt !== undefined) assertReceipt(existingReceipt);
                const stateRequest = states.get(ACTIVE_KEY);
                stateRequest.onsuccess = () => {
                  try {
                    const record = this.checkedRecord(stateRequest.result);
                    const current = record?.kind === "active" ? record : null;
                    const cursor = this.cursorOf(record);
                    if (cursor.generation !== expected.generation)
                      throw new DemoStorageError("conflict", "Esta operación pertenece a una demo anterior. Actualizá la pantalla.");
                    if (existingReceipt) {
                      if ((existingReceipt as DemoCommandReceipt).generation !== cursor.generation)
                        throw new DemoStorageError("conflict", "Este identificador ya se usó en otra demo. Generá una operación nueva.");
                      if (!current) throw new DemoStorageError("corrupt", "Se encontró una operación sin estado de demo.");
                      done({ applied: false, receipt: existingReceipt as DemoCommandReceipt, snapshot: current });
                      return;
                    }
                    if (!sameCursor(cursor, expected))
                      throw new DemoStorageError("conflict", "La demo cambió en otra operación. Actualizá la pantalla antes de reintentar.");
                    const now = new Date(this.now()).toISOString();
                    const snapshot: DemoSnapshot<T> = {
                      schemaVersion: DEMO_SCHEMA_VERSION, kind: "active",
                      generation: cursor.generation, revision: cursor.revision + 1,
                      updatedAt: now, payload,
                    };
                    if (!Number.isSafeInteger(snapshot.revision))
                      throw new DemoStorageError("storage", "Se agotó el contador de revisiones de la demo.");
                    const receipt: DemoCommandReceipt = {
                      commandId, generation: snapshot.generation, revision: snapshot.revision, committedAt: now,
                    };
                    states.put(snapshot, ACTIVE_KEY);
                    receipts.put(receipt, commandId);
                    leases.put({ ownerId: this.ownerId, tabId: this.tabId ?? undefined,
                      expiresAt: this.now() + LEASE_DURATION_MS } satisfies WriterLease, WRITER_KEY);
                    done({ applied: true, receipt, snapshot });
                  } catch (error) { fail(error); }
                };
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      },
    );
    if (result.applied) this.broadcast(result.snapshot.revision);
    return result;
  }

  async exportBackup(): Promise<string> {
    const backup = await this.transaction<DemoBackup<T>>(
      [STATE_STORE, RECEIPTS_STORE], "readonly", (tx, done, fail) => {
        const stateRequest = tx.objectStore(STATE_STORE).get(ACTIVE_KEY);
        stateRequest.onsuccess = () => {
          try {
            const record = this.checkedRecord(stateRequest.result);
            if (record?.kind !== "active") throw new DemoStorageError("storage", "Todavía no hay una demo para respaldar.");
            const receiptRequest = tx.objectStore(RECEIPTS_STORE).getAll();
            receiptRequest.onsuccess = () => {
              try {
                const receipts = receiptRequest.result as unknown[];
                for (const receipt of receipts) assertReceipt(receipt);
                done({ format: DEMO_BACKUP_FORMAT, version: DEMO_SCHEMA_VERSION,
                  exportedAt: new Date(this.now()).toISOString(), snapshot: record,
                  receipts: receipts as DemoCommandReceipt[] });
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      },
    );
    return JSON.stringify(backup, null, 2);
  }

  private parseBackup(raw: string): DemoBackup<T> {
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new DemoStorageError("invalid-backup", "El archivo no contiene JSON válido."); }
    try {
      if (!object(value) || value.format !== DEMO_BACKUP_FORMAT || value.version !== DEMO_SCHEMA_VERSION ||
        typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt)) ||
        !Array.isArray(value.receipts)) throw new Error("envelope");
      const record = this.checkedRecord(value.snapshot);
      if (record?.kind !== "active") throw new Error("snapshot");
      const seen = new Set<string>();
      for (const receipt of value.receipts) {
        assertReceipt(receipt);
        if (seen.has(receipt.commandId) || receipt.revision > record.revision || receipt.generation > record.generation)
          throw new Error("receipts");
        seen.add(receipt.commandId);
      }
      jsonClone(value);
      return value as unknown as DemoBackup<T>;
    } catch {
      throw new DemoStorageError("invalid-backup", "El respaldo es incompatible o está dañado. No se modificó la demo.");
    }
  }

  async previewImport(raw: string): Promise<DemoImportPreview<T>> {
    const backup = this.parseBackup(raw);
    const currentCursor = await this.readCursor();
    return { backup, currentCursor, raw };
  }

  async importBackup(preview: DemoImportPreview<T>, options: { confirmOverwrite: true }): Promise<DemoSnapshot<T>> {
    if (options?.confirmOverwrite !== true)
      throw new DemoStorageError("conflict", "Confirmá expresamente antes de reemplazar la demo.");
    const backup = this.parseBackup(preview.raw);
    const recovered = this.options.recoverPaused(backup.snapshot.payload);
    const importedPayload = jsonClone(recovered ?? backup.snapshot.payload);
    if (!this.options.validatePayload(importedPayload))
      throw new DemoStorageError("invalid-backup", "El estado recuperado del respaldo es inválido. No se modificó la demo.");
    const snapshot = await this.transaction<DemoSnapshot<T>>(
      [STATE_STORE, RECEIPTS_STORE, LEASE_STORE], "readwrite", (tx, done, fail) => {
        const leaseRequest = tx.objectStore(LEASE_STORE).get(WRITER_KEY);
        leaseRequest.onsuccess = () => {
          try {
            this.assertWriter(leaseRequest.result as WriterLease | undefined);
            const stateRequest = tx.objectStore(STATE_STORE).get(ACTIVE_KEY);
            stateRequest.onsuccess = () => {
              try {
                const record = this.checkedRecord(stateRequest.result);
                const cursor = this.cursorOf(record);
                if (!sameCursor(cursor, preview.currentCursor))
                  throw new DemoStorageError("conflict", "La demo cambió desde la vista previa. Volvé a revisar el respaldo.");
                const next: DemoSnapshot<T> = {
                  ...backup.snapshot,
                  generation: cursor.generation + 1,
                  revision: Math.max(cursor.revision, backup.snapshot.revision) + 1,
                  updatedAt: new Date(this.now()).toISOString(),
                  payload: importedPayload,
                };
                if (!Number.isSafeInteger(next.generation) || !Number.isSafeInteger(next.revision))
                  throw new DemoStorageError("invalid-backup", "El respaldo excede los contadores admitidos.");
                // The imported generation is new; source receipts cannot be retried here.
                tx.objectStore(RECEIPTS_STORE).clear();
                tx.objectStore(STATE_STORE).put(next, ACTIVE_KEY);
                done(next);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      },
    );
    this.broadcast(snapshot.revision);
    return snapshot;
  }

  async reset(options: { confirm: true; expected: DemoCursor }): Promise<DemoCursor> {
    if (options?.confirm !== true)
      throw new DemoStorageError("conflict", "Confirmá expresamente antes de borrar la demo.");
    if (!validCursor(options.expected))
      throw new DemoStorageError("conflict", "La referencia de demo para borrar es inválida.");
    const tombstone = await this.transaction<DemoCursor>([STATE_STORE, RECEIPTS_STORE, LEASE_STORE], "readwrite", (tx, done, fail) => {
      const leaseRequest = tx.objectStore(LEASE_STORE).get(WRITER_KEY);
      leaseRequest.onsuccess = () => {
        try {
          this.assertWriter(leaseRequest.result as WriterLease | undefined);
          const stateRequest = tx.objectStore(STATE_STORE).get(ACTIVE_KEY);
          stateRequest.onsuccess = () => {
            try {
              const current = this.cursorOf(this.checkedRecord(stateRequest.result));
              if (!sameCursor(current, options.expected))
                throw new DemoStorageError("conflict", "La demo cambió. Revisala antes de borrar.");
              const next: DemoTombstone = {
                schemaVersion: DEMO_SCHEMA_VERSION, kind: "deleted",
                generation: current.generation + 1, revision: current.revision + 1,
                updatedAt: new Date(this.now()).toISOString(),
              };
              if (!Number.isSafeInteger(next.generation) || !Number.isSafeInteger(next.revision))
                throw new DemoStorageError("storage", "Se agotó el contador de la demo.");
              tx.objectStore(STATE_STORE).put(next, ACTIVE_KEY);
              tx.objectStore(RECEIPTS_STORE).clear();
              done({ generation: next.generation, revision: next.revision });
            } catch (error) { fail(error); }
          };
        } catch (error) { fail(error); }
      };
    });
    this.broadcast(tombstone.revision);
    return tombstone;
  }
}
