import { create } from "zustand";

type ModalId = "addCompetitor" | "editCompetitor" | "confirmReset" | "fightResult" | null;

interface UIState {
  activeModal: ModalId;
  modalData: Record<string, unknown>;
  sidebarOpen: boolean;
  fullscreen: boolean;

  openModal: (id: NonNullable<ModalId>, data?: Record<string, unknown>) => void;
  closeModal: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleFullscreen: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeModal: null,
  modalData: {},
  sidebarOpen: false,
  fullscreen: false,

  openModal: (id, data = {}) => set({ activeModal: id, modalData: data }),
  closeModal: () => set({ activeModal: null, modalData: {} }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),
}));
