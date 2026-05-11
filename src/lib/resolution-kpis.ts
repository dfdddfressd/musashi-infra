interface CountQueryResult {
  count: number | null;
  error: QueryErrorLike | null;
}

interface RecentResolutionRow {
  resolutions_detected: number | null;
}

interface DataQueryResult<T> {
  data: T[] | null;
  error: QueryErrorLike | null;
}

interface QueryErrorLike {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export function readCountOrThrow(metricName: string, result: CountQueryResult): number {
  if (result.error) {
    throw new Error(formatQueryError(metricName, result.error));
  }

  if (result.count === null) {
    throw new Error(`${metricName} query returned a null count.`);
  }

  return result.count;
}

export function sumRecentResolutionsOrThrow(metricName: string, result: DataQueryResult<RecentResolutionRow>): number {
  if (result.error) {
    throw new Error(formatQueryError(metricName, result.error));
  }

  return (result.data ?? []).reduce((sum, row) => sum + (Number(row.resolutions_detected) || 0), 0);
}

function formatQueryError(metricName: string, error: QueryErrorLike): string {
  const parts = [`${metricName} query failed: ${error.message}`];

  if (error.code) {
    parts.push(`code=${error.code}`);
  }

  if (error.details) {
    parts.push(`details=${error.details}`);
  }

  if (error.hint) {
    parts.push(`hint=${error.hint}`);
  }

  return parts.join(' | ');
}
