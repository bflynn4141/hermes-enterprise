import { HermesMotionProvider } from '@hermes/motion-components';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  FirstRunSampleRun,
  type SampleRunView,
} from '../src/app/onboarding/FirstRunSampleRun.js';

declare global {
  interface Window {
    sampleRunFixture: {
      calls: string[];
      mount(view: SampleRunView, reduceMotion?: boolean): void;
      setView(view: SampleRunView): void;
    };
  }
}

function Harness({ initial, reduceMotion }: { initial: SampleRunView; reduceMotion: boolean }) {
  const [view, setView] = useState(initial);
  useEffect(() => {
    window.sampleRunFixture.setView = setView;
  }, []);
  return (
    <HermesMotionProvider reducedMotion={reduceMotion}>
      <main className="first-run-app-surface" style={{ height: '100vh' }}>
        <FirstRunSampleRun
          view={view}
          onRetry={() => window.sampleRunFixture.calls.push('retry')}
          onOpenInbox={() => window.sampleRunFixture.calls.push('open-inbox')}
        />
      </main>
    </HermesMotionProvider>
  );
}

const root = createRoot(document.getElementById('root')!);
window.sampleRunFixture = {
  calls: [],
  mount(view, reduceMotion = false) {
    this.calls = [];
    root.render(<Harness initial={view} reduceMotion={reduceMotion} />);
  },
  setView() {},
};
