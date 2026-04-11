import React, { useRef, useEffect, useState } from "react";

interface Props {
  children: React.ReactNode;
  speed?: number; // px per second
  pauseOnHover?: boolean;
}

/**
 * Vertical auto-scroll container for dashboard lists.
 * If content fits, no scroll. If overflows, smoothly loops.
 */
export default function AutoScroll({ children, speed = 20, pauseOnHover = true }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [needsScroll, setNeedsScroll] = useState(false);
  const [paused, setPaused] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const offset = useRef(0);
  const raf = useRef(0);
  const lastTime = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 768px)");
    const updateCompactMode = () => setCompactMode(media.matches);
    updateCompactMode();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", updateCompactMode);
      return () => media.removeEventListener("change", updateCompactMode);
    }
    media.addListener(updateCompactMode);
    return () => media.removeListener(updateCompactMode);
  }, []);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    // Check if content overflows
    const check = () => setNeedsScroll(inner.scrollHeight > outer.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [children]);

  const shouldAnimate = needsScroll && !compactMode;

  useEffect(() => {
    const inner = innerRef.current;
    if (!shouldAnimate || paused) {
      cancelAnimationFrame(raf.current);
      lastTime.current = 0;
      offset.current = 0;
      if (inner) {
        inner.style.transform = "translateY(0)";
      }
      return;
    }
    if (!inner) return;
    const halfH = inner.scrollHeight / 2;

    const step = (now: number) => {
      if (lastTime.current) {
        const dt = (now - lastTime.current) / 1000;
        offset.current += speed * dt;
        if (offset.current >= halfH) offset.current -= halfH;
        inner.style.transform = `translateY(-${offset.current}px)`;
      }
      lastTime.current = now;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [paused, shouldAnimate, speed]);

  return (
    <div
      ref={outerRef}
      className={`auto-scroll-outer${compactMode ? " is-compact" : ""}`}
      onMouseEnter={() => !compactMode && pauseOnHover && setPaused(true)}
      onMouseLeave={() => {
        setPaused(false);
        lastTime.current = 0;
      }}
    >
      <div ref={innerRef} className="auto-scroll-inner">
        {children}
        {/* Duplicate for seamless loop */}
        {shouldAnimate && children}
      </div>
    </div>
  );
}
