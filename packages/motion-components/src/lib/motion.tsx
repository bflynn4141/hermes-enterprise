import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
const MotionPreference = createContext(false);
/** OS reduced motion is always honored; the provider can also request less motion. */
export function useReducedMotion() {
  const override = useContext(MotionPreference);
  const [system, setSystem] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setSystem(media.matches);
    change(); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return override || system;
}
export function HermesMotionProvider({ reducedMotion = false, children }: { reducedMotion?: boolean; children: ReactNode }) {
  return <MotionPreference.Provider value={reducedMotion}><MotionBoundary>{children}</MotionBoundary></MotionPreference.Provider>;
}
function MotionBoundary({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return <MotionConfig reducedMotion={reduce ? 'always' : 'user'}><div className="hermes-ui" data-reduced-motion={reduce}>{children}</div></MotionConfig>;
}
