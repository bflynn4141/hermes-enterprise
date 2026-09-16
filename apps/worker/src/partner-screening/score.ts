import type { PartnerAgentConfig } from './config.js';

export interface PublicOrganization {
  readonly id: number;
  readonly node_id: string;
  readonly login: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly html_url: string;
  readonly blog: string | null;
  readonly public_repos: number;
  readonly followers: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PublicRepository {
  readonly id: number;
  readonly node_id: string;
  readonly name: string;
  readonly full_name: string;
  readonly html_url: string;
  readonly description: string | null;
  readonly topics: readonly string[];
  readonly language: string | null;
  readonly stargazers_count: number;
  readonly forks_count: number;
  readonly open_issues_count: number;
  readonly fork: boolean;
  readonly archived: boolean;
  readonly disabled: boolean;
  readonly has_issues: boolean;
  readonly license: { readonly spdx_id: string | null } | null;
  readonly pushed_at: string | null;
  readonly updated_at: string;
}

export interface DiscoveryPriorityCriterion {
  readonly id: 'relevance' | 'activity' | 'adoption' | 'openness';
  readonly label: string;
  readonly points: number;
  readonly points_max: number;
  readonly evidence: string;
  readonly source_artifact_keys: readonly string[];
}

export interface DiscoveryPriority {
  readonly total: number;
  readonly criteria: readonly DiscoveryPriorityCriterion[];
  readonly confidence: 'high' | 'medium' | 'low';
  readonly gaps: readonly string[];
  readonly sourceUpdatedAt: string | null;
}

const weighted = (raw: number, maximum: number): number =>
  Math.max(0, Math.min(maximum, Math.round((raw / 100) * maximum)));

const validTime = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const recencyRaw = (ageDays: number): number => {
  if (ageDays <= 30) return 100;
  if (ageDays <= 90) return 80;
  if (ageDays <= 180) return 60;
  if (ageDays <= 365) return 40;
  if (ageDays <= 730) return 20;
  return 5;
};

/**
 * Transparent source-side triage. This deliberately is not an agent judgment:
 * it only orders evidence for Iris to inspect, using the exact weights saved on
 * the run. A human still decides every Inbox request Iris proposes.
 */
export function deterministicDiscoveryPriority(
  organization: PublicOrganization,
  repositories: readonly PublicRepository[],
  config: PartnerAgentConfig,
  options: { now: Date; searchIncomplete: boolean; explicitOnly: boolean },
): DiscoveryPriority {
  const orgText = [organization.login, organization.name, organization.description]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  const repoText = repositories
    .flatMap((repo) => [repo.name, repo.description ?? '', repo.language ?? '', ...repo.topics])
    .join(' ')
    .toLowerCase();
  const matches = config.keywords.filter((keyword) => `${orgText} ${repoText}`.includes(keyword.toLowerCase()));
  const relevanceRaw = Math.round((matches.length / config.keywords.length) * 100);

  const pushedTimes = repositories.map((repo) => validTime(repo.pushed_at)).filter((value): value is number => value !== null);
  const latestPush = pushedTimes.length > 0 ? Math.max(...pushedTimes) : null;
  const ageDays = latestPush === null ? null : Math.max(0, (options.now.getTime() - latestPush) / 86_400_000);
  const activityRaw = ageDays === null ? 0 : recencyRaw(ageDays);

  const totalStars = repositories.reduce((sum, repo) => sum + Math.max(0, repo.stargazers_count), 0);
  const adoptionRaw = Math.min(100, Math.round((Math.log10(totalStars + 1) / 3) * 100));

  const active = repositories.filter((repo) => !repo.archived && !repo.disabled);
  const licensed = active.filter((repo) => Boolean(repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION'));
  const issueEnabled = active.filter((repo) => repo.has_issues);
  const opennessRaw = active.length === 0
    ? 0
    : Math.round((licensed.length / active.length) * 70 + (issueEnabled.length / active.length) * 20 + 10);

  const keys = {
    organization: `org:${organization.node_id}`,
    repositories: `repos:${organization.node_id}`,
  } as const;
  const weights = config.ranking_weights;
  const criteria: DiscoveryPriorityCriterion[] = [
    {
      id: 'relevance', label: 'Configured keyword relevance',
      points: weighted(relevanceRaw, weights.relevance), points_max: weights.relevance,
      evidence: matches.length > 0
        ? `${matches.length} of ${config.keywords.length} configured keywords matched public organization or repository metadata: ${matches.join(', ')}.`
        : `None of the ${config.keywords.length} configured keywords matched the fetched public metadata.`,
      source_artifact_keys: [keys.organization, keys.repositories],
    },
    {
      id: 'activity', label: 'Recent public repository activity',
      points: weighted(activityRaw, weights.activity), points_max: weights.activity,
      evidence: ageDays === null ? 'No public repository push date was available.' : `Most recent public push was ${Math.floor(ageDays)} days before this run.`,
      source_artifact_keys: [keys.repositories],
    },
    {
      id: 'adoption', label: 'Public repository adoption',
      points: weighted(adoptionRaw, weights.adoption), points_max: weights.adoption,
      evidence: `${repositories.length} fetched public repositories have ${totalStars} stars in total; the capped score uses log10(stars + 1).`,
      source_artifact_keys: [keys.repositories],
    },
    {
      id: 'openness', label: 'Open-source collaboration signals',
      points: weighted(opennessRaw, weights.openness), points_max: weights.openness,
      evidence: `${active.length} repositories are active; ${licensed.length} publish a recognized SPDX license and ${issueEnabled.length} enable issues.`,
      source_artifact_keys: [keys.repositories],
    },
  ];

  const gaps: string[] = [];
  if (matches.length === 0) gaps.push('No configured relevance keyword matched the fetched metadata.');
  if (repositories.length === 0) gaps.push('No public organization repositories were returned.');
  if (ageDays === null) gaps.push('Repository activity recency could not be established.');
  else if (ageDays > config.lookback_days) gaps.push(`Latest public push is older than the configured ${config.lookback_days}-day lookback.`);
  if (options.searchIncomplete) gaps.push('GitHub marked at least one search result set incomplete.');
  if (options.explicitOnly) gaps.push('This organization came from explicit URL intake; no search-result relevance was independently established.');
  gaps.push('Public metadata cannot establish capacity, commercial interest, availability, or consent to partner.');

  const sourceTimes = [validTime(organization.updated_at), ...repositories.map((repo) => validTime(repo.updated_at))]
    .filter((value): value is number => value !== null);
  const confidence: DiscoveryPriority['confidence'] = repositories.length === 0
    ? 'low'
    : options.searchIncomplete || matches.length === 0
      ? 'medium'
      : 'high';

  return {
    total: criteria.reduce((sum, criterion) => sum + criterion.points, 0),
    criteria,
    confidence,
    gaps,
    sourceUpdatedAt: sourceTimes.length > 0 ? new Date(Math.max(...sourceTimes)).toISOString() : null,
  };
}

