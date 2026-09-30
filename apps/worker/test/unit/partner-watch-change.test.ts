import { describe, expect, it } from 'vitest';
import { githubWatchChangedFacts,githubWatchFingerprint } from '../../src/partner-screening/watch-change.js';
import { partnerAgentConfigSchema } from '../../src/partner-screening/config.js';
import { selectedWatchConfig,watchSourceOptions } from '../../src/partner-screening/watch.js';

const repository = { full_name: 'ExampleOrg/sdk', description: 'SDK for agents', pushed_at: '2026-09-20T00:00:00Z', topics: ['sdk', 'agents'], stargazers_count: 50, updated_at: '2026-09-20T00:00:00Z' };
const artifacts = (repos: Record<string, unknown>[]) => [{ kind: 'repository_snapshot', content: { repositories: repos } }];

describe('meaningful GitHub watch evidence', () => {
  it('stays quiet for fetch times, popularity counters, metadata update timestamps, and ordering', async () => {
    const first = await githubWatchFingerprint(artifacts([repository]));
    const next = await githubWatchFingerprint(artifacts([{ ...repository, topics: ['agents', 'sdk'], stargazers_count: 99, updated_at: '2026-09-30T00:00:00Z', fetched_at: '2026-09-30T00:00:00Z' }]));
    expect(next).toBe(first);
  });

  it('wakes for new activity, changed substantive metadata, or new repository evidence', async () => {
    const first = await githubWatchFingerprint(artifacts([repository]));
    for (const next of [
      [{ ...repository, pushed_at: '2026-09-30T00:00:00Z' }],
      [{ ...repository, description: 'New integration and SDK' }],
      [repository, { ...repository, full_name: 'ExampleOrg/integration' }],
    ]) expect(await githubWatchFingerprint(artifacts(next))).not.toBe(first);
  });

  it('records an honest observed before/after activity fact, ignoring counter noise',()=>{
    expect(githubWatchChangedFacts(artifacts([repository]),artifacts([{...repository,pushed_at:'2026-09-30T00:00:00Z',stargazers_count:99}])))
      .toEqual([{field:'ExampleOrg/sdk · pushed_at',before:'"2026-09-20T00:00:00Z"',after:'"2026-09-30T00:00:00Z"'}]);
  });

  it('keeps a bounded excerpt around an actual metadata change beyond the initial text',()=>{
    const prefix='Existing documentation. '.repeat(50);
    const changes=githubWatchChangedFacts(artifacts([{...repository,description:`${prefix}Legacy SDK`}]),artifacts([{...repository,description:`${prefix}Migration guide`}]))
    expect(changes).toHaveLength(1);
    expect(changes[0]!.before).toContain('Legacy SDK');
    expect(changes[0]!.after).toContain('Migration guide');
    expect(changes[0]!.before!.length).toBeLessThanOrEqual(502);
  });

  it('permits only existing organization sources, preserves stable source selection, and validates free budgets',()=>{
    const raw={source:'github',source_purpose:'organization_partner_research',organization_only:true,no_outreach:true,role_label:'Technical partner',keywords:['agents'],
      intake_urls:['https://github.com/FirstOrg','https://github.com/SecondOrg','https://github.com/SecondOrg/sdk'],
      github_watch:{enabled:true,source_id:'url:1',max_cost_usd_per_run:0.1,max_cost_usd_per_day:0.3,max_model_calls:6}};
    const config=partnerAgentConfigSchema.parse(raw);
    expect(watchSourceOptions(config)).toEqual([{id:'url:0',label:'GitHub · FirstOrg'},{id:'url:1',label:'GitHub · SecondOrg'}]);
    expect(selectedWatchConfig(config).intake_urls).toEqual(['https://github.com/SecondOrg']);
    expect(selectedWatchConfig(config).search_queries).toEqual([]);
    expect(partnerAgentConfigSchema.safeParse({...raw,github_watch:{...raw.github_watch,max_cost_usd_per_day:0.05}}).success).toBe(false);
    expect(partnerAgentConfigSchema.safeParse({...raw,max_spend_usd:0.15}).success).toBe(false);
    expect(()=>selectedWatchConfig({...config,github_watch:{...config.github_watch!,source_id:'url:2'}})).toThrow('Choose an existing configured GitHub organization');
  });
});
