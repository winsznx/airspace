import { useEffect, useRef, useState } from "react";

/**
 * Fires once, the first time an element is on screen.
 *
 * Deliberately one-shot and self-disconnecting: the point is a single moment of
 * emphasis as the section arrives, not an effect that replays every time the
 * reader scrolls past. Returns true immediately where IntersectionObserver is
 * unavailable, so the content is never gated behind an API that might be
 * missing.
 */
export function useInViewOnce<T extends Element>(rootMargin = "-15% 0px"): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);

  return [ref, seen];
}
