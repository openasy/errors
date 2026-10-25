// What the search window (Cmd+K) finds in Errors: issues by title or culprit, from the API, and projects by name.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Bug, FolderCode } from "lucide-react";
import type { Issue, Level, Project } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;
const query = (q: string) => new URLSearchParams({ q, limit: "8" });

const LEVEL = { fatal: "critical", error: "high", warning: "medium", info: "info", debug: "info" } as const satisfies Record<Level, string>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const [found, projects] = await Promise.all([
      call<{ issues: Issue[] }>(`/api/v1/issues?${query(q)}`, { signal }),
      call<{ projects: Project[] }>("/api/v1/projects?limit=500", { signal }),
    ]);
    const issues: SearchResult[] = found.issues.map((i) => ({
      id: `issue:${i.id}`,
      label: i.title,
      detail: t("search.issueDetail", { culprit: i.culprit ?? "–", project: i.project.name, events: i.events }),
      kind: t("search.issue"),
      icon: Bug,
      severity: LEVEL[i.level],
      href: `/issues/${encodeURIComponent(i.id)}`,
    }));
    const named: SearchResult[] = projects.projects
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((p) => ({
        id: `project:${p.id}`,
        label: p.name,
        detail: t("search.projectDetail", { unresolved: p.unresolved }),
        kind: t("search.project"),
        icon: FolderCode,
        mono: true,
        href: "/projects",
      }));
    return [...issues, ...named];
  };
}
