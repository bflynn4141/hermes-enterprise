import { useState } from 'react';
import { Button } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';

export function AdminRunLimits({ dailyLimit, concurrentLimit, onSave }: {
  dailyLimit: number | null;
  concurrentLimit: number;
  onSave: (patch: { daily_token_cap: number | null; max_concurrent_runs: number }) => Promise<boolean>;
}) {
  const [daily, setDaily] = useState(dailyLimit === null ? '' : String(dailyLimit));
  const [concurrent, setConcurrent] = useState(String(concurrentLimit));
  const [busy, setBusy] = useState(false);
  const parsedDaily = daily.trim() === '' ? null : Number(daily);
  const parsedConcurrent = Number(concurrent);
  const valid = (parsedDaily === null || (Number.isSafeInteger(parsedDaily) && parsedDaily >= 0))
    && concurrent.trim() !== '' && Number.isInteger(parsedConcurrent) && parsedConcurrent >= 1 && parsedConcurrent <= 50;
  const changed = parsedDaily !== dailyLimit || parsedConcurrent !== concurrentLimit;
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!valid || !changed || busy) return;
      setBusy(true);
      void onSave({ daily_token_cap: parsedDaily, max_concurrent_runs: parsedConcurrent }).finally(() => setBusy(false));
    }}>
      <AdminSettingsCard title="Usage limits" description="Set how much your agents can use each day, and how many tasks run at once."
        footer={<><p>Changes apply to the workspace and are recorded in History.</p><Button type="submit" primary disabled={!valid || !changed || busy}>{busy ? 'Saving…' : 'Save limits'}</Button></>}>
        <label className="field"><span>Daily usage limit</span><input type="number" min="0" step="1" placeholder="No limit" value={daily} disabled={busy} onChange={(event) => setDaily(event.target.value)} /><span className="meta">Counted in tokens, the small pieces of text models read and write. Leave blank for no limit; zero pauses all agent work.</span></label>
        <label className="field"><span>Tasks at the same time</span><input type="number" min="1" max="50" step="1" value={concurrent} disabled={busy} onChange={(event) => setConcurrent(event.target.value)} /><span className="meta">Between 1 and 50.</span></label>
      </AdminSettingsCard>
    </form>
  );
}
