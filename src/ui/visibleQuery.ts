import { useEffect } from "react";

// Scope the timer and its result to the visible consumer. An older request can
// finish after navigation, but only its original consumer may accept it.
export function useVisibleQuery<T>(
  read: () => Promise<T>,
  accept: (value: T) => void,
  fail: (error: unknown) => void,
  deps: readonly unknown[],
  interval = 10000,
) {
  useEffect(() => {
    let alive = true,
      busy = false,
      generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async () => {
      if (!alive || document.hidden || busy) return;
      const ticket = generation;
      busy = true;
      try {
        const v = await read();
        if (alive && !document.hidden && ticket === generation) accept(v);
      } catch (e) {
        if (alive && !document.hidden && ticket === generation) fail(e);
      } finally {
        busy = false;
        if (alive && !document.hidden)
          timer = setTimeout(update, generation === ticket ? interval : 0);
      }
    };
    const visibility = () => {
      generation++;
      clearTimeout(timer);
      if (!document.hidden) void update();
    };
    void update();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, deps);
}
