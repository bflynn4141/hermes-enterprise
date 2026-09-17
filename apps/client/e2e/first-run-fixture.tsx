import { HermesMotionProvider } from '@hermes/motion-components';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  FirstRunSetup,
  type FirstRunState,
  type IrisReadyStatus,
  type WorkingAgreement,
} from '../src/app/onboarding/FirstRunSetup.js';

export interface FirstRunFixtureOptions {
  reduceMotion?: boolean;
  irisStatus?: IrisReadyStatus;
}

interface FixtureCall {
  method: 'state' | 'open-inbox';
  step?: FirstRunState['step'];
  agreement?: WorkingAgreement;
}

declare global {
  interface Window {
    firstRunFixture: {
      calls: FixtureCall[];
      mount(options?: FirstRunFixtureOptions): void;
      setIrisStatus(status: IrisReadyStatus): void;
    };
  }
}

function Harness({ options }: { options: FirstRunFixtureOptions }) {
  const [irisStatus, setIrisStatus] = useState<IrisReadyStatus>(options.irisStatus ?? 'ready');
  useEffect(() => { window.firstRunFixture.setIrisStatus = setIrisStatus; }, []);
  return <HermesMotionProvider reducedMotion={options.reduceMotion}>
    <FirstRunSetup irisStatus={irisStatus}
      onStateChange={(state, agreement) => window.firstRunFixture.calls.push({ method: 'state', step: state.step, agreement })}
      onOpenInbox={() => window.firstRunFixture.calls.push({ method: 'open-inbox' })} />
  </HermesMotionProvider>;
}

const root = createRoot(document.getElementById('root')!);
window.firstRunFixture = {
  calls: [],
  mount(options = {}) { this.calls = []; root.render(<Harness options={options} />); },
  setIrisStatus() {},
};
