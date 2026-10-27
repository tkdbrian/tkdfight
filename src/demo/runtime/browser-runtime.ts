import {
  DemoRepository, DemoStorageError, makeDemoCommandId,
  type DemoImportPreview, type DemoSnapshot,
} from "@/demo/storage";
import { emptyDemoDeskState, reduceDemoDeskState } from "./reducer";
import type { DemoDeskCommand, DemoDeskState } from "./types";
import { isDemoDeskState } from "./validator";

export interface DeskRuntimeView {
  state: DemoDeskState;
  generation: number;
  revision: number;
  isWriter: boolean;
}

export interface DeskRuntime {
  readonly isWriter: boolean;
  open(): Promise<DeskRuntimeView>;
  read(): Promise<DeskRuntimeView>;
  acquireWriter(): Promise<boolean>;
  subscribe(listener: (view: DeskRuntimeView) => void): () => void;
  /** Pass makeDemoCommandId(view.generation) at action creation when a retry is possible. */
  dispatch(command: DemoDeskCommand, commandId?: string): Promise<DeskRuntimeView>;
  exportBackup(): Promise<string>;
  previewImport(raw: string): Promise<DemoImportPreview<DemoDeskState>>;
  importBackup(preview: DemoImportPreview<DemoDeskState>, options: { confirmOverwrite: true }): Promise<DeskRuntimeView>;
  reset(options: { confirm: true }): Promise<DeskRuntimeView>;
  close(): Promise<void>;
}

export interface BrowserDeskRuntimeOptions {
  databaseName?: string;
  indexedDBFactory?: IDBFactory;
  now?: () => number;
}

function recoverPaused(state: DemoDeskState): DemoDeskState | null {
  const active = state.active;
  if (!active || active.paused || !["round", "overtime"].includes(active.state.phase)) return null;
  return { ...state, active: { ...active, paused: true } };
}

export class BrowserDeskRuntime implements DeskRuntime {
  private readonly repository: DemoRepository<DemoDeskState>;
  private readonly blank = emptyDemoDeskState();
  private readonly listeners = new Set<(view: DeskRuntimeView) => void>();
  private unsubscribeRepository: (() => void) | null = null;
  private closed = false;
  private opening: Promise<DeskRuntimeView> | null = null;

  constructor(options: BrowserDeskRuntimeOptions = {}) {
    this.repository = new DemoRepository<DemoDeskState>({
      validatePayload: isDemoDeskState, recoverPaused,
      databaseName: options.databaseName, indexedDBFactory: options.indexedDBFactory,
      now: options.now,
    });
  }

  get isWriter(): boolean { return this.repository.isWriter; }

  private view(snapshot: DemoSnapshot<DemoDeskState> | null): DeskRuntimeView {
    return { state: snapshot?.payload ?? this.blank, generation: snapshot?.generation ?? 0,
      revision: snapshot?.revision ?? -1,
      isWriter: this.repository.isWriter };
  }

  private ensureOpen(): void {
    if (this.closed) throw new DemoStorageError("unavailable", "La demo ya se cerró en esta pestaña.");
  }

  open(): Promise<DeskRuntimeView> {
    this.ensureOpen();
    if (this.opening) return this.opening;
    const pending = this.openOnce();
    this.opening = pending;
    void pending.then(
      () => { if (this.opening === pending) this.opening = null; },
      () => { if (this.opening === pending) this.opening = null; },
    );
    return pending;
  }

  private async openOnce(): Promise<DeskRuntimeView> {
    const initial = await this.repository.open();
    this.ensureOpen();
    if (!this.unsubscribeRepository) {
      this.unsubscribeRepository = this.repository.subscribe(() => {
        void this.read().then((view) => {
          for (const listener of this.listeners) {
            try { listener(view); } catch { /* An observer cannot invalidate committed data. */ }
          }
        }).catch(() => { /* Caller can retry read; storage remains authoritative. */ });
      });
    }
    if (!this.repository.isWriter) await this.repository.acquireWriter();
    this.ensureOpen();
    const recovered = initial ? await this.repository.read() : null;
    if (!recovered && this.repository.isWriter) {
      try {
        const cursor = await this.repository.readCursor();
        const committed = await this.repository.commit(cursor,
          makeDemoCommandId(cursor.generation, `initialize:${cursor.revision}`), this.blank);
        return this.view(committed.snapshot);
      } catch (error) {
        if (!(error instanceof DemoStorageError) || error.code !== "conflict") throw error;
      }
    }
    return this.read();
  }

  async read(): Promise<DeskRuntimeView> {
    this.ensureOpen();
    const snapshot = await this.repository.read();
    if (snapshot) return this.view(snapshot);
    const cursor = await this.repository.readCursor();
    return { state: this.blank, ...cursor, isWriter: this.isWriter };
  }

  async acquireWriter(): Promise<boolean> {
    this.ensureOpen();
    return this.repository.acquireWriter();
  }

  subscribe(listener: (view: DeskRuntimeView) => void): () => void {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispatch(command: DemoDeskCommand, commandId?: string): Promise<DeskRuntimeView> {
    this.ensureOpen();
    if (!this.isWriter) throw new DemoStorageError("read-only", "Otra pestaña está operando esta demo.");
    const snapshot = await this.repository.read();
    if (!snapshot) throw new DemoStorageError("storage", "La demo no está inicializada.");
    // Caller IDs belong to their original generation; never retag a delayed
    // action after reset/import, even when the reducer could apply it again.
    const id = commandId ?? makeDemoCommandId(snapshot.generation);
    const prefix = `g${snapshot.generation}:`;
    if (typeof id !== "string" || !id.startsWith(prefix) || id.length === prefix.length || /\s/.test(id))
      throw new DemoStorageError("conflict", "Esta operación pertenece a otra demo. Actualizá la pantalla.");
    let next: DemoDeskState;
    try {
      next = reduceDemoDeskState(snapshot.payload, command, new Date());
    } catch (error) {
      // A lost response may be retried after its state transition is already visible.
      // The repository stores durable command receipts. Do not run the reducer again.
      const backup = JSON.parse(await this.repository.exportBackup()) as {
        receipts: Array<{ commandId: string; generation: number }>;
      };
      if (backup.receipts.some((receipt) => receipt.commandId === id
        && receipt.generation === snapshot.generation)) return this.read();
      throw error;
    }
    const committed = await this.repository.commit(snapshot, id, next);
    return this.view(committed.snapshot);
  }

  exportBackup(): Promise<string> { return this.repository.exportBackup(); }

  previewImport(raw: string): Promise<DemoImportPreview<DemoDeskState>> {
    return this.repository.previewImport(raw);
  }

  async importBackup(preview: DemoImportPreview<DemoDeskState>, options: { confirmOverwrite: true }): Promise<DeskRuntimeView> {
    this.ensureOpen();
    return this.view(await this.repository.importBackup(preview, options));
  }

  async reset(options: { confirm: true }): Promise<DeskRuntimeView> {
    this.ensureOpen();
    if (options?.confirm !== true)
      throw new DemoStorageError("conflict", "Confirmá expresamente antes de borrar la demo.");
    const current = await this.repository.readCursor();
    const cursor = await this.repository.reset({ confirm: true, expected: current });
    const next = emptyDemoDeskState();
    const committed = await this.repository.commit(cursor,
      makeDemoCommandId(cursor.generation, `initialize:${next.eventId}`), next);
    return this.view(committed.snapshot);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.opening; } catch { /* Closing is still required after a failed open. */ }
    this.unsubscribeRepository?.();
    this.unsubscribeRepository = null;
    this.listeners.clear();
    await this.repository.close();
  }
}

export function createBrowserDeskRuntime(options?: BrowserDeskRuntimeOptions): DeskRuntime {
  return new BrowserDeskRuntime(options);
}
