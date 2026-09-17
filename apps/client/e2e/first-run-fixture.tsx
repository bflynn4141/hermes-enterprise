import { HermesMotionProvider } from '@hermes/motion-components';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  FirstRunSetup,
  type FirstRunState,
  type LiveSearchStatus,
  type ProviderStatus,
  type WorkingAgreement,
} from '../src/app/onboarding/FirstRunSetup.js';

export interface FirstRunFixtureOptions {
  reduceMotion?: boolean;
  providerStatus?: ProviderStatus;
  liveSearchStatus?: LiveSearchStatus;
}

interface FixtureCall {
  method: 'state' | 'ready' | 'retry-live-search' | 'open-inbox';
  step?: FirstRunState['step'];
  agreement?: WorkingAgreement;
}

declare global {
  interface Window {
    firstRunFixture: {
      calls: FixtureCall[];
      mount(options?: FirstRunFixtureOptions): void;
      setProviderStatus(status: ProviderStatus): void;
      setLiveSearchStatus(status: LiveSearchStatus, completed?: readonly string[]): void;
    };
  }
}

function Harness({ options }: { options: FirstRunFixtureOptions }) {
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>(options.providerStatus ?? 'disconnected');
  const [liveSearchStatus, setLiveSearchStatus] = useState<LiveSearchStatus>(options.liveSearchStatus ?? 'idle');
  const [completed, setCompleted] = useState<readonly string[]>([]);

  useEffect(() => {
    window.firstRunFixture.setProviderStatus = setProviderStatus;
    window.firstRunFixture.setLiveSearchStatus = (status, stages = []) => {
      setCompleted(stages);
      setLiveSearchStatus(status);
    };
  }, []);

  return (
    <HermesMotionProvider reducedMotion={options.reduceMotion}>
      <FirstRunSetup
        providerStatus={providerStatus}
        liveSearchStatus={liveSearchStatus}
        completedLiveStages={completed}
        onStateChange={(state, agreement) => window.firstRunFixture.calls.push({ method: 'state', step: state.step, agreement })}
        onReadyForTest={(state, agreement) => window.firstRunFixture.calls.push({ method: 'ready', step: state.step, agreement })}
        onRetryLiveSearch={() => window.firstRunFixture.calls.push({ method: 'retry-live-search' })}
        onOpenInbox={() => window.firstRunFixture.calls.push({ method: 'open-inbox' })}
      />
    </HermesMotionProvider>
  );
}

const root = createRoot(document.getElementById('root')!);
window.firstRunFixture = {
  calls: [],
  mount(options = {}) {
    this.calls = [];
    root.render(<Harness options={options} />);
  },
  setProviderStatus() {},
  setLiveSearchStatus() {},
};
