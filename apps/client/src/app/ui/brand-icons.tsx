// Logos for the services Hermes connects to (Slack, Gmail, Google, Microsoft),
// so a connection is recognisable at a glance (docs/DESIGN.md, Connections). Drawn from the Iconify "logos" set
// (@iconify-json/logos 1.2.14, CC0-1.0); the marks themselves belong to their
// owners and appear only to name the service being connected.
import { useId, type JSX } from 'react';

export type BrandName = 'slack' | 'gmail' | 'google' | 'microsoft' | 'email';

const slack = (): JSX.Element => (
  <svg viewBox="0 0 256 256">
    <path fill="#e01e5a" d="M53.841 161.32c0 14.832-11.987 26.82-26.819 26.82S.203 176.152.203 161.32c0-14.831 11.987-26.818 26.82-26.818H53.84zm13.41 0c0-14.831 11.987-26.818 26.819-26.818s26.819 11.987 26.819 26.819v67.047c0 14.832-11.987 26.82-26.82 26.82c-14.83 0-26.818-11.988-26.818-26.82z" />
    <path fill="#36c5f0" d="M94.07 53.638c-14.832 0-26.82-11.987-26.82-26.819S79.239 0 94.07 0s26.819 11.987 26.819 26.819v26.82zm0 13.613c14.832 0 26.819 11.987 26.819 26.819s-11.987 26.819-26.82 26.819H26.82C11.987 120.889 0 108.902 0 94.069c0-14.83 11.987-26.818 26.819-26.818z" />
    <path fill="#2eb67d" d="M201.55 94.07c0-14.832 11.987-26.82 26.818-26.82s26.82 11.988 26.82 26.82s-11.988 26.819-26.82 26.819H201.55zm-13.41 0c0 14.832-11.988 26.819-26.82 26.819c-14.831 0-26.818-11.987-26.818-26.82V26.82C134.502 11.987 146.489 0 161.32 0s26.819 11.987 26.819 26.819z" />
    <path fill="#ecb22e" d="M161.32 201.55c14.832 0 26.82 11.987 26.82 26.818s-11.988 26.82-26.82 26.82c-14.831 0-26.818-11.988-26.818-26.82V201.55zm0-13.41c-14.831 0-26.818-11.988-26.818-26.82c0-14.831 11.987-26.818 26.819-26.818h67.25c14.832 0 26.82 11.987 26.82 26.819s-11.988 26.819-26.82 26.819z" />
  </svg>
);

function Gmail(): JSX.Element {
  // Gradient ids are per instance: two Gmail marks on one page must not share one.
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 256 204">
      <defs>
        <linearGradient id={`${id}a`} x1="165" x2="165" y1="44" y2="166" gradientUnits="userSpaceOnUse">
          <stop stopColor="#60d673" /><stop offset=".17" stopColor="#42c868" /><stop offset=".39" stopColor="#0ebc5f" /><stop offset=".62" stopColor="#00a9bb" /><stop offset=".86" stopColor="#3c90ff" /><stop offset="1" stopColor="#3186ff" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="8" x2="184" y1="46.13" y2="46.13" gradientUnits="userSpaceOnUse">
          <stop offset=".08" stopColor="#ff63a0" /><stop offset=".3" stopColor="#fc413d" /><stop offset=".5" stopColor="#fc413d" /><stop offset=".65" stopColor="#fc413d" /><stop offset=".72" stopColor="#fc5c30" /><stop offset=".86" stopColor="#feb10c" /><stop offset=".91" stopColor="#fec700" /><stop offset=".96" stopColor="#ffdb0f" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id}a)`} d="M146 44h38v110c0 6.627-5.373 12-12 12h-20a6 6 0 0 1-6-6z" transform="translate(-11.636 -37.818)scale(1.45454)" />
      <path fill="#fc413d" d="M55.273 26.182H0v160c0 9.638 7.816 17.454 17.455 17.454h29.09a8.727 8.727 0 0 0 8.728-8.728z" />
      <path fill={`url(#${id}b)`} d="M39.226 30.456c-8.033-6.752-20.018-5.714-26.77 2.319c-6.752 8.032-5.714 20.017 2.319 26.77l76.078 63.949a8 8 0 0 0 10.295 0l76.078-63.95c8.032-6.752 9.07-18.737 2.318-26.77c-6.752-8.032-18.737-9.07-26.769-2.318L96 78.18z" transform="translate(-11.636 -37.818)scale(1.45454)" />
    </svg>
  );
}

const google = (): JSX.Element => (
  <svg viewBox="0 0 256 262">
    <path fill="#4285f4" d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622l38.755 30.023l2.685.268c24.659-22.774 38.875-56.282 38.875-96.027" />
    <path fill="#34a853" d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055c-34.523 0-63.824-22.773-74.269-54.25l-1.531.13l-40.298 31.187l-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1" />
    <path fill="#fbbc05" d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82c0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602z" />
    <path fill="#eb4335" d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0C79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251" />
  </svg>
);

const microsoft = (): JSX.Element => (
  <svg viewBox="0 0 256 256">
    <path fill="#f1511b" d="M121.666 121.666H0V0h121.666z" />
    <path fill="#80cc28" d="M256 121.666H134.335V0H256z" />
    <path fill="#00adef" d="M121.663 256.002H0V134.336h121.663z" />
    <path fill="#fbbc09" d="M256 256.002H134.335V134.336H256z" />
  </svg>
);

/** Email as such, for a place that holds either provider: a plain envelope in the text colour. */
const email = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m4 7 8 6 8-6" strokeLinecap="round" />
  </svg>
);

const MARKS: Record<BrandName, () => JSX.Element> = { slack, gmail: Gmail, google, microsoft, email };

/** A service's logo in a fixed square, so marks of different shapes line up. */
export function BrandIcon({ name, size = 20 }: { name: BrandName; size?: number }) {
  const Mark = MARKS[name];
  return (
    <span className="brand-icon" style={{ width: size, height: size }} aria-hidden="true">
      <Mark />
    </span>
  );
}
