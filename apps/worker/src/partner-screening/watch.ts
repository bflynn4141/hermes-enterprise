import { partnerWatchSchema, type PartnerWatch, type PartnerWatchUpdate, type EnterpriseSkillAssignment } from '@hermes/shared';
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/errors.js';
import { resolvePartnerSkillAssignment, updateEnterpriseSkillAssignment } from '../enterprise-skills/service.js';
import type { PartnerAgentConfig } from './config.js';
import { organizationFromIntakeUrl } from './github.js';
import { githubWatchChangedFacts, githubWatchFingerprint } from './watch-change.js';
import { resolveRuntimeBinding } from '../runtime/config.js';
import { requestRunStop } from '../runs/stop.js';

export const DEFAULT_WATCH_BUDGET = { max_cost_usd_per_run: 0.10, max_cost_usd_per_day: 0.30, max_model_calls: 6 };

/** One explicit organization from already approved settings; no search/page churn. */
export function watchSourceOptions(config: PartnerAgentConfig | null): { id: string; label: string }[] {
  if (config?.source !== 'github') return [];
  return config.intake_urls.flatMap((url,index) => {
    const login = organizationFromIntakeUrl(url);
    const path = new URL(url).pathname.split('/').filter(Boolean);
    return login && path.length === 1 ? [{ id:`url:${index}`,label:`GitHub · ${login}` }] : [];
  });
}

export function selectedWatchConfig(config: PartnerAgentConfig): PartnerAgentConfig {
  const selected = watchSourceOptions(config).find(({ id }) => id === config.github_watch?.source_id);
  if (!selected) throw new RouteError('Choose an existing configured GitHub organization.', 'watch_source_unavailable',409);
  const index = Number(selected.id.split(':')[1]);
  return { ...config,search_queries:[],intake_urls:[config.intake_urls[index]!],max_candidates:1 };
}

export interface WatchCheck {
  id: string; workspace_id: string; agent_id: string; owner_user_id: string;
  assignment_id: string; assignment_revision: number; screening_run_id: string;
  status: 'checking'|'baseline'|'unchanged'|'changed'|'failed'|'cancelled';
  source_id: string; source_scope_sha256: string; candidate_fingerprints: Record<string,string>;
  changed_candidate_ids: string[]; selected_candidate_id: string|null; run_id: string|null;
  previous_screening_run_id:string|null;change_summary:ReturnType<typeof githubWatchChangedFacts>;
}

export async function watchCheckForScreening(tx: Tx, workspaceId: string, screeningRunId: string): Promise<WatchCheck|null> {
  return (await tx.query<WatchCheck>('SELECT * FROM partner_watch_checks WHERE workspace_id=$1 AND screening_run_id=$2',[workspaceId,screeningRunId])).rows[0] ?? null;
}

export async function requireWatchCheckAuthority(tx: Tx, checkId: string): Promise<void> {
  const result = await tx.query<{allowed:boolean}>('SELECT partner_watch_check_authorized($1) AS allowed',[checkId]);
  if (!result.rows[0]?.allowed) throw new RouteError('This watch was paused or its owner/settings changed.', 'partner_watch_authority_stale',409);
}

export async function beginWatchCheck(tx: Tx, input: {
  workspaceId:string;agentId:string;ownerId:string;screeningRunId:string;
  assignment:EnterpriseSkillAssignment;config:PartnerAgentConfig;
}): Promise<WatchCheck> {
  const watch = input.config.github_watch;
  if (!watch?.enabled) throw new RouteError('Enable the watch before checking.', 'partner_watch_paused',409);
  const scope = await githubWatchFingerprint([{kind:'organization_profile',content:{
    node_id: JSON.stringify({url:input.config.intake_urls,keywords:input.config.keywords,ranking_weights:input.config.ranking_weights,minimum_priority:input.config.minimum_priority,lookback_days:input.config.lookback_days}),
  }}]);
  await tx.query(`INSERT INTO partner_watch_checks
    (workspace_id,agent_id,owner_user_id,assignment_id,assignment_revision,screening_run_id,
     source_id,source_scope_sha256,max_api_requests,max_cost_usd_per_run,max_cost_usd_per_day,max_model_calls)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(screening_run_id) DO NOTHING`,
    [input.workspaceId,input.agentId,input.ownerId,input.assignment.id,input.assignment.revision,input.screeningRunId,
      watch.source_id,scope,input.config.max_api_requests,watch.max_cost_usd_per_run,watch.max_cost_usd_per_day,watch.max_model_calls]);
  const check = await watchCheckForScreening(tx,input.workspaceId,input.screeningRunId);
  if (!check) throw new Error('partner_watch_check_missing');
  await requireWatchCheckAuthority(tx,check.id);
  return check;
}

/** Reserve before the network request; worker restart cannot refill allowance. */
export async function reserveWatchSourceRequest(tx: Tx,checkId:string): Promise<void> {
  await requireWatchCheckAuthority(tx,checkId);
  const {rows} = await tx.query(`UPDATE partner_watch_checks SET api_requests_used=api_requests_used+1
    WHERE id=$1 AND workspace_id=app_workspace_id() AND status='checking' AND cancelled_at IS NULL AND api_requests_used<max_api_requests RETURNING id`,[checkId]);
  if (!rows[0]) throw new RouteError('This watch used its source request budget.', 'partner_watch_source_budget_exhausted',409);
}

/** Persist all fingerprints before handing a single meaningful change to Iris. */
export async function completeWatchCheck(tx:Tx,workspaceId:string,checkId:string):Promise<WatchCheck> {
  // Use the same agent lock as admission so two source completions cannot
  // independently compare against one baseline and prepare duplicate work.
  await tx.query(`SELECT a.id FROM agents a JOIN partner_watch_checks c ON c.workspace_id=a.workspace_id AND c.agent_id=a.id
    WHERE c.workspace_id=$1 AND c.id=$2 FOR UPDATE OF a`,[workspaceId,checkId]);
  const check = (await tx.query<WatchCheck>('SELECT * FROM partner_watch_checks WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,checkId])).rows[0];
  if (!check) throw new Error('partner_watch_check_missing');
  if (check.status !== 'checking') return check;
  await requireWatchCheckAuthority(tx,check.id);
  const {rows} = await tx.query<{candidate_id:string;source_key:string;deterministic_priority:number;content:{kind:string;content:Record<string,unknown>}[]}>(`
    SELECT rc.candidate_id,c.source_key,rc.deterministic_priority,
      jsonb_agg(jsonb_build_object('kind',a.kind,'content',a.content) ORDER BY a.kind,a.id) AS content
    FROM partner_screening_run_candidates rc JOIN partner_candidates c ON c.id=rc.candidate_id AND c.workspace_id=rc.workspace_id
    JOIN partner_source_artifacts a ON a.workspace_id=rc.workspace_id AND a.run_id=rc.run_id AND a.id=ANY(rc.artifact_ids)
    WHERE rc.workspace_id=$1 AND rc.run_id=$2 GROUP BY rc.candidate_id,c.source_key,rc.deterministic_priority
    ORDER BY rc.deterministic_priority DESC,rc.candidate_id`,[workspaceId,check.screening_run_id]);
  const previous = (await tx.query<WatchCheck>(`SELECT * FROM partner_watch_checks
    WHERE workspace_id=$1 AND agent_id=$2 AND source_scope_sha256=$3 AND id<>$4
      AND status IN ('baseline','unchanged','changed') AND cancelled_at IS NULL ORDER BY checked_at DESC,id DESC LIMIT 1`,
    [workspaceId,check.agent_id,check.source_scope_sha256,check.id])).rows[0];
  const fingerprints:Record<string,string> = {};
  const changed:string[] = [];
  const config = (await tx.query<{config_snapshot:{minimum_priority?:number}}>('SELECT config_snapshot FROM partner_screening_runs WHERE workspace_id=$1 AND id=$2',[workspaceId,check.screening_run_id])).rows[0]?.config_snapshot;
  for (const candidate of rows) {
    const digest = await githubWatchFingerprint(candidate.content);
    fingerprints[candidate.source_key]=digest;
    if (previous && previous.candidate_fingerprints[candidate.source_key] !== digest
        && candidate.deterministic_priority >= (config?.minimum_priority ?? 0)) changed.push(candidate.candidate_id);
  }
  const status = !previous ? 'baseline' : changed.length ? 'changed' : 'unchanged';
  const before=previous ? (await tx.query<{kind:string;content:Record<string,unknown>}>(`SELECT a.kind,a.content
    FROM partner_source_artifacts a JOIN partner_screening_run_candidates rc ON rc.workspace_id=a.workspace_id AND rc.run_id=a.run_id AND a.id=ANY(rc.artifact_ids)
    WHERE a.workspace_id=$1 AND a.run_id=$2`,[workspaceId,previous.screening_run_id])).rows : [];
  const selected=rows.find(candidate=>candidate.candidate_id===changed[0]);
  const summary=selected ? githubWatchChangedFacts(before,selected.content) : [];
  if(selected) {
    // Register only server-selected immutable evidence, while the app source
    // transaction has write authority. Runtime agents may only read resources.
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({
      check_id:check.id,source_scope:check.source_scope_sha256,screening_run_id:check.screening_run_id,
      previous_screening_run_id:previous?.screening_run_id ?? null,fingerprints,change_summary:summary,
    })));
    const digestHex=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    await tx.query(`INSERT INTO approval_resources
      (workspace_id,resource_key,kind,label,owner_member_id,version,sha256,executor_available,active)
      SELECT $1,$2,'artifact','GitHub partner watch research brief',m.id,$3,$4,false,true
      FROM members m WHERE m.workspace_id=$1 AND m.user_id=$5 AND m.status='active'
      ON CONFLICT(workspace_id,resource_key) DO NOTHING`,
      [workspaceId,`partner-watch:${check.id}`,check.screening_run_id,digestHex,check.owner_user_id]);
  }
  return (await tx.query<WatchCheck>(`UPDATE partner_watch_checks SET status=$3,candidate_fingerprints=$4::jsonb,
    changed_candidate_ids=$5,selected_candidate_id=$6,previous_screening_run_id=$7,change_summary=$8::jsonb,completed_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId,check.id,status,JSON.stringify(fingerprints),changed,changed[0] ?? null,previous?.screening_run_id ?? null,JSON.stringify(summary)])).rows[0]!;
}

export async function requireWatchOwner(tx:Tx,workspaceId:string,userId:string,agentId:string):Promise<{status:string}> {
  const row = (await tx.query<{status:string}>(`SELECT a.status FROM agents a JOIN members m ON m.workspace_id=a.workspace_id
    WHERE a.workspace_id=$1 AND a.id=$2 AND m.user_id=$3 AND m.status='active'
      AND EXISTS(SELECT 1 FROM agent_owners o WHERE o.workspace_id=a.workspace_id AND o.agent_id=a.id AND o.member_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM agent_owners o WHERE o.workspace_id=a.workspace_id AND o.agent_id=a.id AND o.member_id<>m.id)
      AND NOT EXISTS(SELECT 1 FROM enterprise_team_agents t WHERE t.workspace_id=a.workspace_id AND t.agent_id=a.id AND t.principal_user_id<>$3)`,[workspaceId,agentId,userId])).rows[0];
  if (!row) throw new RouteError('No accessible agent watch.', 'not_found',404);
  return row;
}

export async function partnerWatchView(tx:Tx,env:Env,workspaceId:string,userId:string,agentId:string):Promise<PartnerWatch> {
  const agent = await requireWatchOwner(tx,workspaceId,userId,agentId);
  const resolved = await resolvePartnerSkillAssignment(env,tx,workspaceId,agentId);
  const assignment = resolved.assignment;
  // A paused assignment still exposes its reviewed settings to its owner.
  const config = assignment?.config as PartnerAgentConfig | undefined;
  const options = watchSourceOptions(config ?? null);
  const settings = config?.github_watch;
  const enabled = Boolean(settings?.enabled && assignment?.state === 'active' && assignment.schedule.enabled);
  const mayConfigure = Boolean(assignment && config?.source === 'github' && options.length);
  const last = (await tx.query<{
    id:string;checked_at:Date;status:string;candidate_fingerprints:Record<string,string>;changed_candidate_ids:string[];
    run_id:string|null;session_id:string|null;run_status:string|null;review_id:string|null;error_code:string|null;run_error:{reason?:string}|null;cancelled_at:Date|null;authorized:boolean;
  }>(`SELECT c.*,partner_watch_check_authorized(c.id) AS authorized,r.session_id,r.status AS run_status,r.error AS run_error FROM partner_watch_checks c LEFT JOIN runs r ON r.id=c.run_id AND r.workspace_id=c.workspace_id
    WHERE c.workspace_id=$1 AND c.agent_id=$2 AND c.owner_user_id=$3 ORDER BY c.checked_at DESC,c.id DESC LIMIT 1`,[workspaceId,agentId,userId])).rows[0];
  let blocked:string|null = !assignment ? 'assignment_missing' : !mayConfigure ? 'unsupported_source'
    : assignment.state==='paused' ? 'assignment_paused' : !enabled ? 'watch_paused' : agent.status !== 'started' ? 'agent_not_started'
    : env.AUTOMATED_TRIGGERS_ENABLED !== '1' ? 'automated_triggers_disabled' : null;
  if(!blocked && !options.some(source=>source.id===settings?.source_id)) blocked='watch_source_unavailable';
  if (!blocked && env.MODEL_SCRIPTED !== '1') {
    const key = (await tx.query(`SELECT 1 FROM workspace_provider_keys k JOIN catalog c ON c.provider=k.provider
      JOIN workspace_settings ws ON ws.workspace_id=k.workspace_id JOIN agents a ON a.workspace_id=ws.workspace_id AND a.id=$2
      WHERE k.workspace_id=$1 AND k.status IN ('verified','verified_scoped') AND k.revoked_at IS NULL
        AND c.model_id=COALESCE(a.model_id,ws.default_model_id) AND c.supports_tools AND c.disabled_reason IS NULL LIMIT 1`,[workspaceId,agentId])).rows[0];
    if (!key || env.AGENT_RUNTIME!=='hermes') blocked='provider_unavailable';
    else try {await resolveRuntimeBinding(env,tx,workspaceId,agentId);} catch {blocked='runtime_unavailable';}
    if(!blocked) {
      const model=(await tx.query<{context_length:number|null;pricing_verified_on:string|null;pricing_per_million:{input?:number;output?:number;cached_input?:number}}>(`
        SELECT c.context_length,c.pricing_verified_on,c.pricing_per_million FROM catalog c JOIN workspace_settings ws ON ws.workspace_id=$1
        JOIN agents a ON a.workspace_id=ws.workspace_id AND a.id=$2 WHERE c.model_id=COALESCE(a.model_id,ws.default_model_id)`,[workspaceId,agentId])).rows[0];
      const pricing=model?.pricing_per_million;
      if(!model?.context_length || !model.pricing_verified_on || typeof pricing?.input!=='number' || typeof pricing?.output!=='number') blocked='watch_model_price_unknown';
      else {
        const reserve=((model.context_length-2048)*Math.max(pricing.input,pricing.cached_input??pricing.input)+2048*pricing.output)/1e6;
        if(reserve>(settings?.max_cost_usd_per_run??DEFAULT_WATCH_BUDGET.max_cost_usd_per_run)) blocked='watch_model_budget_too_small';
      }
    }
  }
  const active = last?.run_status && ['working','waiting','stopping'].includes(last.run_status);
  const latestReview=(await tx.query<{id:string;created_at:Date}>(`SELECT q.id,q.created_at FROM partner_watch_checks c
    JOIN requests q ON q.workspace_id=c.workspace_id AND q.id=c.review_id
    WHERE c.workspace_id=$1 AND c.agent_id=$2 AND c.owner_user_id=$3 ORDER BY q.created_at DESC LIMIT 1`,[workspaceId,agentId,userId])).rows[0];
  const staleSource=last?.status==='checking' && !last.authorized && !last.cancelled_at;
  const state = !mayConfigure ? 'unconfigured' : !enabled ? 'paused' : last?.status === 'checking' && last.authorized && !last.cancelled_at ? 'checking'
    : active ? 'working' : blocked || staleSource || (!last?.cancelled_at && (last?.status === 'failed' || (last?.run_status && ['error','stopped'].includes(last.run_status)) || (last?.run_status==='completed' && !last.review_id))) ? 'needs_attention' : 'ready';
  return partnerWatchSchema.parse({
    agent_id:agentId,assignment_id:assignment?.id ?? null,revision:assignment?.revision ?? null,
    enabled,execution_mode:env.MODEL_SCRIPTED==='1'?'simulated':'live',interval_minutes:assignment?.schedule.interval_minutes ?? 360,selected_source:options.find(o=>o.id===settings?.source_id) ?? null,
    source_options:options,max_api_requests:config?.max_api_requests ?? 0,budget:settings ? {
      max_cost_usd_per_run:settings.max_cost_usd_per_run,max_cost_usd_per_day:settings.max_cost_usd_per_day,max_model_calls:settings.max_model_calls,
    } : DEFAULT_WATCH_BUDGET,
    state,may_configure:mayConfigure,may_run:!blocked && !active && !(last?.status==='checking' && last.authorized && !last.cancelled_at) && !(last?.run_id && !last.review_id && !last.cancelled_at),blocked_reason:blocked,
    next_check_at:enabled && !blocked ? new Date((Math.floor(Date.now()/((assignment?.schedule.interval_minutes ?? 360)*60000))+1)*(assignment?.schedule.interval_minutes ?? 360)*60000).toISOString() : null,
    latest_review:latestReview ? {id:latestReview.id,created_at:latestReview.created_at.toISOString()} : null,
    last_check:last ? {id:last.id,checked_at:last.checked_at.toISOString(),status:last.cancelled_at ? 'cancelled' : last.status,candidates_checked:Object.keys(last.candidate_fingerprints).length,
      changed_candidates:last.changed_candidate_ids.length,run_id:last.run_id,session_id:last.session_id,review_id:last.review_id,error_code:last.cancelled_at ? null : staleSource ? 'partner_watch_authority_stale' : last.run_error?.reason ?? (last.run_status==='completed' && !last.review_id ? 'partner_watch_review_missing' : last.error_code)} : null,
  });
}

export async function updatePartnerWatch(tx:Tx,env:Env,workspaceId:string,userId:string,agentId:string,input:PartnerWatchUpdate,jobs:string[]=[]):Promise<PartnerWatch> {
  await requireWatchOwner(tx,workspaceId,userId,agentId);
  const resolved = await resolvePartnerSkillAssignment(env,tx,workspaceId,agentId);
  const current = resolved.assignment;
  if (!current) throw new RouteError('Configure the existing partner skill first.','watch_not_configured',409);
  const config = current.config as PartnerAgentConfig;
  if (!watchSourceOptions(config).some(source=>source.id===input.source_id)) throw new RouteError('Choose an existing GitHub organization source.','watch_source_unavailable',409);
  const {revision,interval_minutes,...settings}=input;
  try {
    await updateEnterpriseSkillAssignment(tx,workspaceId,agentId,current.id,userId,{
      revision,config:{...current.config,github_watch:settings},schedule:{enabled:settings.enabled,interval_minutes},
    });
  } catch(error) {
    if (error instanceof Error && error.message==='enterprise_skill_assignment_stale') throw new RouteError('This watch changed; reload before saving.','stale_revision',409);
    throw error;
  }
  const cancelled=await tx.query<{run_id:string|null}>(`UPDATE partner_watch_checks SET cancelled_at=now()
    WHERE workspace_id=$1 AND agent_id=$2 AND assignment_id=$3 AND assignment_revision<>$4 AND status IN('checking','changed') AND review_id IS NULL AND cancelled_at IS NULL RETURNING run_id`,
    [workspaceId,agentId,current.id,revision+1]);
  for(const check of cancelled.rows) if(check.run_id) jobs.push(...await requestRunStop(tx,workspaceId,check.run_id));
  await tx.query(`INSERT INTO events(workspace_id,actor_type,actor_user_id,kind,agent_id) VALUES($1,'user',$2,'settings.changed',$3)`,[workspaceId,userId,agentId]);
  return partnerWatchView(tx,env,workspaceId,userId,agentId);
}
