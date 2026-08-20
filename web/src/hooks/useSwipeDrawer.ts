import { useEffect, useRef } from "react";

type UseSwipeDrawerOptions = {
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Max screen width in px to enable swipe (default: 820) */
  maxWidth?: number;
};

export function useSwipeDrawer({
  isOpen,
  onOpen,
  onClose,
  maxWidth = 820,
}: UseSwipeDrawerOptions) {
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startTimeRef = useRef(0);
  const isTrackingRef = useRef(false);
  const isHorizontalSwipeRef = useRef(false);

  useEffect(() => {
    const isMobile = () => window.innerWidth <= maxWidth;

    const onTouchStart = (e: TouchEvent) => {
      if (!isMobile() || e.touches.length !== 1) return;

      const target = e.target as HTMLElement | null;
      // Don't intercept sliders, interactive controls, or inputs
      if (
        target &&
        (target.closest("input") ||
          target.closest("button") ||
          target.closest(".waveform") ||
          target.closest(".speed-slider") ||
          target.closest(".vol-fader") ||
          target.closest(".modal"))
      ) {
        return;
      }

      const touch = e.touches[0];
      startXRef.current = touch.clientX;
      startYRef.current = touch.clientY;
      startTimeRef.current = Date.now();
      isTrackingRef.current = true;
      isHorizontalSwipeRef.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isTrackingRef.current || !isMobile() || e.touches.length !== 1) return;

      const touch = e.touches[0];
      const deltaX = touch.clientX - startXRef.current;
      const deltaY = touch.clientY - startYRef.current;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      // Determine gesture direction
      if (!isHorizontalSwipeRef.current) {
        if (absX > 10 || absY > 10) {
          if (absX > absY * 1.2) {
            isHorizontalSwipeRef.current = true;
          } else {
            // It's a vertical scroll, cancel tracking
            isTrackingRef.current = false;
            return;
          }
        }
      }

      if (isHorizontalSwipeRef.current) {
        // Prevent accidental pull-to-refresh or vertical jump during clean horizontal swipe
        if (absX > 20 && absX > absY * 1.5 && e.cancelable) {
          e.preventDefault();
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isTrackingRef.current || !isHorizontalSwipeRef.current || !isMobile()) {
        isTrackingRef.current = false;
        isHorizontalSwipeRef.current = false;
        return;
      }

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - startXRef.current;
      const deltaTime = Math.max(1, Date.now() - startTimeRef.current);
      const velocityX = deltaX / deltaTime; // px per ms

      isTrackingRef.current = false;
      isHorizontalSwipeRef.current = false;

      const minDistance = 50;
      const isFlick = Math.abs(velocityX) > 0.25;

      if (!isOpen) {
        // Swiping right from left half of the screen opens drawer
        if ((deltaX > minDistance || (isFlick && velocityX > 0)) && startXRef.current < window.innerWidth * 0.5) {
          onOpen();
        }
      } else {
        // Swiping left closes drawer
        if (deltaX < -minDistance || (isFlick && velocityX < 0)) {
          onClose();
        }
      }
    };

    const options = { passive: false };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, options);
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [isOpen, onOpen, onClose, maxWidth]);
}
