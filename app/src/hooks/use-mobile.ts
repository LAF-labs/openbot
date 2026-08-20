import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  /*
   * MEASURED ON THE FIRST RENDER, NOT THE SECOND. This started as `undefined`, which the return
   * coerced to false — so a narrow window painted the full desktop sidebar for one frame and then
   * threw it away when the effect ran. The reader sees a 340px rail flash and vanish on every load.
   */
  const [isMobile, setIsMobile] = React.useState(
    () =>
      typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
