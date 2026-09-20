const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

/** Shared minimal TypeSafe client. It never logs provider bodies or secrets. */
export async function callSystemOne(
  apiKey: string,
  input: { state: Record<string, unknown>; model: string; questions: Record<string, unknown> },
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(TYPESAFE_SYSTEM_ONE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`typesafe_http_${response.status}`);
  return response.json();
}

