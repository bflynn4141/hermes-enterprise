/** Stable public evidence, excluding fetch times and engagement-counter noise. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().flatMap((key) =>
      ['updated_at', 'fetched_at', 'stargazers_count', 'forks_count', 'open_issues_count', 'followers', 'public_repos'].includes(key)
        ? [] : [[key, canonical(record[key])]],
    ));
  }
  return value;
}

type Artifact = { readonly kind: string; readonly content: Record<string, unknown> };
function meaningfulMaterial(artifacts: readonly Artifact[]): unknown {
  const orgFields = ['node_id','login','name','description','html_url','blog'];
  const repoFields = ['node_id','full_name','description','topics','language','fork','archived','disabled','has_issues','license','pushed_at'];
  const pick = (value: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields
    .filter((field) => value[field] !== undefined).map((field) => [field,value[field]]));
  return canonical(artifacts.flatMap(({ kind,content }) => {
    if (kind === 'organization_profile') return [{ kind,content:pick(content,orgFields) }];
    if (kind !== 'repository_snapshot') return [];
    const repositories = Array.isArray(content.repositories) ? content.repositories : [];
    return [{ kind,content:{ repositories:repositories.filter((repo): repo is Record<string,unknown> => Boolean(repo) && typeof repo === 'object' && !Array.isArray(repo)).map(repo => pick(repo,repoFields)) } }];
  }));
}

export async function githubWatchFingerprint(artifacts: readonly Artifact[]): Promise<string> {
  const material = meaningfulMaterial(artifacts);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(material)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface WatchChangedFact { field:string; before:string|null; after:string|null }

/** Bounded before/after facts remain data behind the evidence tool, never instructions. */
export function githubWatchChangedFacts(before:readonly Artifact[],after:readonly Artifact[]):WatchChangedFact[] {
  const facts = (artifacts:readonly Artifact[]) => {
    const output:Record<string,string>={};
    for (const artifact of meaningfulMaterial(artifacts) as {kind:string;content:Record<string,unknown>}[]) {
      if (artifact.kind==='organization_profile') {
        for (const [key,value] of Object.entries(artifact.content)) output[`Organization ${key}`]=JSON.stringify(value);
      } else {
        for (const repo of artifact.content.repositories as Record<string,unknown>[]) {
          const name=String(repo.full_name ?? repo.node_id ?? 'repository').slice(0,200);
          for (const [key,value] of Object.entries(repo)) output[`${name} · ${key}`]=JSON.stringify(value);
        }
      }
    }
    return output;
  };
  const prior=facts(before),current=facts(after);
  return [...new Set([...Object.keys(prior),...Object.keys(current)])].sort()
    .filter(key=>prior[key]!==current[key]).slice(0,20)
    .map(field=>{
      const oldValue=prior[field],newValue=current[field];
      let difference=0;
      while(oldValue && newValue && difference<Math.min(oldValue.length,newValue.length) && oldValue[difference]===newValue[difference]) difference++;
      const start=Math.max(0,difference-100);
      const excerpt=(value:string|undefined) => value===undefined ? null : value.length<=500 ? value
        : `${start?'…':''}${value.slice(start,start+500)}${value.length>start+500?'…':''}`;
      return {field,before:excerpt(oldValue),after:excerpt(newValue)};
    });
}
