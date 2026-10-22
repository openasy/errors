// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  projects: number;
  /** Issues by status. */
  issues: Record<string, number>;
  /** Unresolved issues that came back after being fixed. */
  regressions: number;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="errors",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_errors_projects Projects that may send events.",
    "# TYPE openasy_errors_projects gauge",
    `openasy_errors_projects ${g.projects}`,
    "# HELP openasy_errors_issues Issues by status.",
    "# TYPE openasy_errors_issues gauge",
    ...Object.entries(g.issues).map(([s, n]) => `openasy_errors_issues{status="${s}"} ${n}`),
    "# HELP openasy_errors_regressions Unresolved issues that came back after being fixed.",
    "# TYPE openasy_errors_regressions gauge",
    `openasy_errors_regressions ${g.regressions}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
