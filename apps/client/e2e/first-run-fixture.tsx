import { HermesMotionProvider } from '@hermes/motion-components';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  FirstRunSetup,
  type FirstRunState,
  type ProviderStatus,
  type SampleStatus,
  type WorkingAgreement,
} from '../src/app/onboarding/FirstRunSetup.js';

export interface FirstRunFixtureOptions {
  reduceMotion?: boolean;
  providerStatus?: ProviderStatus;
  sampleStatus?: SampleStatus;
}

interface FixtureCall {
  method: 'state' | 'ready' | 'run-sample' | 'open-sample';
  step?: FirstRunState['step'];
  agreement?: WorkingAgreement;
}

declare global {
  interface Window {
    firstRunFixture: {
      calls: FixtureCall[];
      mount(options?: FirstRunFixtureOptions): void;
      setProviderStatus(status: ProviderStatus): void;
      setSampleStatus(status: SampleStatus, completed?: readonly string[]): void;
    };
  }
}

function Harness({ options }: { options: FirstRunFixtureOptions }) {
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>(options.providerStatus ?? 'disconnected');
  const [sampleStatus, setSampleStatus] = useState<SampleStatus>(options.sampleStatus ?? 'idle');
  const [completed, setCompleted] = useState<readonly string[]>([]);

  useEffect(() => {
    window.firstRunFixture.setProviderStatus = setProviderStatus;
    window.firstRunFixture.setSampleStatus = (status, stages = []) => {
      setCompleted(stages);
      setSampleStatus(status);
    };
  }, []);

  return (
    <HermesMotionProvider reducedMotion={options.reduceMotion}>
      <FirstRunSetup
        providerStatus={providerStatus}
        sampleStatus={sampleStatus}
        completedSampleStages={completed}
        onStateChange={(state, agreement) => window.firstRunFixture.calls.push({ method: 'state', step: state.step, agreement })}
        onReadyForTest={(state, agreement) => window.firstRunFixture.calls.push({ method: 'ready', step: state.step, agreement })}
        onRunSample={() => window.firstRunFixture.calls.push({ method: 'run-sample' })}
        onOpenSample={() => window.firstRunFixture.calls.push({ method: 'open-sample' })}
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
  setSampleStatus() {},
};
