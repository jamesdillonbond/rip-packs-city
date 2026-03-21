const TOPSHOT_GRAPHQL_URL = "https://public-api.nbatopshot.com/graphql";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

export async function topshotGraphql<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(TOPSHOT_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "sports-collectible-tool/0.1",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  const rawText = await response.text();

  let json: GraphQLResponse<T> | null = null;
  try {
    json = JSON.parse(rawText) as GraphQLResponse<T>;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new Error(
      `Top Shot GraphQL failed with ${response.status}. Response body: ${rawText}`
    );
  }

  if (json?.errors?.length) {
    throw new Error(
      json.errors.map((error) => error.message).filter(Boolean).join("; ")
    );
  }

  if (!json?.data) {
    throw new Error(`Top Shot GraphQL returned no data. Raw body: ${rawText}`);
  }

  return json.data;
}