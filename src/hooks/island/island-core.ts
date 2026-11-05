// The island route's long-lived actions that the extracted island hooks call back into.
// The route holds a `core` ref and assigns it just before its return, like `hopActions`.
// Hooks read it at call time, so they never capture a stale function.
export type IslandCore = {
  dropTake: () => void;
  setPlayWhenLoaded: (on: boolean) => void;
  resetForNewAudio: () => void;
  go: (target: number, keepPlaying?: boolean) => void;
  closePanel: () => void;
  endRun: () => void;
  playFromTop: () => Promise<void>;
};
