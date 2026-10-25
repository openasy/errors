import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  FacetFilter,
  FilterBar,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SearchInput,
  SegmentedControl,
  SeverityBadge,
  StatusBadge,
  Tabs,
  TextField,
  TimeSeriesChart,
  usePath,
  useThemePreference,
  useAgo,
  toLocale,
  useLocalePreference,
  BarList,
  DonutChart,
  OverviewGrid,
  SEVERITY_META,
  StackedBarChart,
  TONE_COLORS,
  type Column,
  type ProductId,
  type Severity as UiSeverity,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  Activity,
  Bug,
  CircleCheck,
  EyeOff,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  type Frame,
  type EventDay,
  type Issue,
  type IssueDetail,
  type IssueStatus,
  type Level,
  type Overview,
  type ProductLink,
  type Project,
  type Release,
  type Summary,
} from "./api.ts";
import { useT } from "./i18n.ts";
import { search } from "./search.ts";

// Five levels of an application become the shared scale of four plus info.
const LEVEL: Record<Level, UiSeverity> = { fatal: "critical", error: "high", warning: "medium", info: "low", debug: "info" };

const PAGES = ["projects", "setup", "account", "members", "signin", "tokens", "about"] as const;
type Route = { page: "overview" | "issues" | (typeof PAGES)[number] } | { page: "issue"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", "issues", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "issues" && id) return { page: "issue", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  if (page === "issues") return { page: "issues" };
  return { page: "overview" };
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg">{children}</pre>;
}

function StatusLabel({ issue }: { issue: Pick<Issue, "status" | "regression"> }) {
  const t = useT();
  if (issue.regression && issue.status === "unresolved") return <StatusBadge tone="danger">{t("statusLabel.regression")}</StatusBadge>;
  if (issue.status === "resolved") return <StatusBadge tone="success">{t("statusLabel.resolved")}</StatusBadge>;
  if (issue.status === "ignored") return <StatusBadge tone="neutral">{t("statusLabel.ignored")}</StatusBadge>;
  return <StatusBadge tone="warning">{t("statusLabel.unresolved")}</StatusBadge>;
}

// ---------------------------------------------------------------- Issues

type Sort = "lastSeen" | "events" | "users" | "firstSeen";

function OverviewPage({ call, summary }: { call: Call; summary?: Summary }) {
  const ago = useAgo();
  const t = useT();
  const [o, setO] = useState<Overview>();
  useEffect(() => void call<Overview>("/api/v1/overview").then(setO, () => {}), [call, summary]);
  const s = summary;
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const color = (l: string) => (l in LEVEL ? TONE_COLORS[SEVERITY_META[LEVEL[l as Level]].tone] : TONE_COLORS.neutral);
  const columns: Column<Overview["topIssues"][number]>[] = [
    {
      id: "level",
      header: t("issuesPage.level"),
      width: "96px",
      cell: (i) => (i.level in LEVEL ? <SeverityBadge severity={LEVEL[i.level as Level]} /> : i.level),
    },
    {
      id: "issue",
      header: t("issuesPage.issue"),
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-1.5">
            <a href={`/issues/${i.id}`} className="font-medium">
              {i.title}
            </a>
            {i.regression && <Badge tone="danger">{t("issuesPage.regressions")}</Badge>}
          </span>
          {i.culprit && <span className="truncate font-mono text-xs text-fg-muted">{i.culprit}</span>}
        </span>
      ),
    },
    { id: "project", header: t("issuesPage.project"), width: "140px", cell: (i) => <span className="text-xs">{i.project}</span> },
    { id: "events", header: t("overviewPage.events7Days"), width: "120px", align: "right", cell: (i) => i.events7d },
    { id: "users", header: t("issuesPage.users"), width: "90px", align: "right", cell: (i) => i.users },
  ];
  return (
    <>
      <PageHeader
        title={t("overviewPage.overview")}
        description={
          s
            ? t("issuesPage.inTheLastDayLast", {
                plural: t("plurals.project", { count: s.projects }),
                plural2: t("plurals.event", { count: s.events24h }),
                ago: ago(s.lastEventAt),
              })
            : undefined
        }
      />
      {s && (
        <KpiGrid minWidth={150}>
          <KpiCard
            label={t("issuesPage.unresolved")}
            value={s.issues.unresolved}
            icon={Bug}
            tone={s.issues.unresolved ? "warning" : "success"}
            trend={o?.newIssues.map((d) => d.issues)}
            trendColor={TONE_COLORS.warning}
            href="/issues"
          />
          <KpiCard label={t("issuesPage.regressions")} value={s.regressions} icon={RotateCcw} tone={s.regressions ? "danger" : "success"} href="/issues" />
          <KpiCard label={t("issuesPage.events24Hours")} value={s.events24h} icon={Activity} tone="info" trend={s.days.map((d) => d.events)} />
          <KpiCard label={t("issuesPage.resolved")} value={s.issues.resolved} icon={CircleCheck} />
          <KpiCard label={t("issuesPage.ignored")} value={s.issues.ignored} icon={EyeOff} />
        </KpiGrid>
      )}
      {s && (
        <OverviewGrid>
          <Panel title={t("issuesPage.eventsOverTime")} description={t("issuesPage.eachDayOfTheLast")}>
            <DailyEvents label={t("issuesPage.eventsEachDayOfThe")} days={s.days} />
          </Panel>
          <Panel title={t("overviewPage.byLevel")} description={t("overviewPage.byLevelDetail")}>
            {o && o.byLevel.length ? (
              <DonutChart
                label={t("overviewPage.byLevel")}
                caption={t("overviewPage.unresolved")}
                slices={o.byLevel.map((l) => ({ id: l.level, name: l.level, value: l.unresolved, color: color(l.level), href: "/issues" }))}
              />
            ) : (
              <EmptyState title={t("issuesPage.noUnresolvedIssues")} />
            )}
          </Panel>
        </OverviewGrid>
      )}
      {o && (
        <OverviewGrid>
          <Panel title={t("overviewPage.newIssues")} description={t("overviewPage.newIssuesDetail")}>
            <StackedBarChart
              label={t("overviewPage.newIssues")}
              categories={o.newIssues.map((d) => day(d.day))}
              segments={[{ id: "issues", name: t("overviewPage.newIssues"), color: TONE_COLORS.warning }]}
              values={o.newIssues.map((d) => [d.issues])}
              height={170}
              xTicks={7}
            />
          </Panel>
          <Panel title={t("overviewPage.byProject")} description={t("overviewPage.byProjectDetail")}>
            {o.byProject.length ? (
              <BarList
                label={t("overviewPage.byProject")}
                items={o.byProject.map((p) => ({ id: p.id, label: p.name, value: p.unresolved, href: "/issues" }))}
              />
            ) : (
              <EmptyState title={t("issuesPage.noUnresolvedIssues")} />
            )}
          </Panel>
        </OverviewGrid>
      )}
      {o && o.topIssues.length > 0 && (
        <Panel title={t("overviewPage.busiest")} description={t("overviewPage.busiestDetail")} flush>
          <DataTable label={t("overviewPage.busiest")} rows={o.topIssues} columns={columns} getRowId={(i) => i.id} />
        </Panel>
      )}
    </>
  );
}

function IssuesPage({ call, summary }: { call: Call; summary?: Summary }) {
  const ago = useAgo();
  const t = useT();
  const [tab, setTab] = useState<IssueStatus>("unresolved");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [environment, setEnvironment] = useState("");
  const [release, setRelease] = useState("");
  const [sort, setSort] = useState<Sort>("lastSeen");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Issue[]>();
  const [more, setMore] = useState<string>();
  useEffect(
    () =>
      void call<{ projects: Project[] }>("/api/v1/projects?limit=500").then(
        (r) => setProjects(r.projects),
        () => {},
      ),
    [call],
  );
  // The releases of the chosen project, or of all of them; a release name two projects share is one choice.
  const [releases, setReleases] = useState<Array<{ release: string; issues: number }>>([]);
  useEffect(() => {
    const p = new URLSearchParams({ limit: "500" });
    if (project) p.set("project", project);
    void call<{ releases: Release[] }>(`/api/v1/releases?${p}`).then(
      (r) => {
        const issues = new Map<string, number>();
        for (const x of r.releases) issues.set(x.release, (issues.get(x.release) ?? 0) + x.issues);
        setReleases([...issues].map(([release, n]) => ({ release, issues: n })));
      },
      () => setReleases([]),
    );
  }, [call, project]);

  const query = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams({ status: tab, sort, limit: "100" });
      if (project) p.set("project", project);
      if (environment) p.set("environment", environment);
      if (release) p.set("release", release);
      if (q.trim()) p.set("q", q.trim());
      if (cursor) p.set("cursor", cursor);
      return call<{ issues: Issue[]; nextCursor?: string }>(`/api/v1/issues?${p}`);
    },
    [call, tab, sort, project, environment, release, q],
  );
  const load = useCallback(
    () =>
      void query().then(
        (r) => (setRows(r.issues), setMore(r.nextCursor)),
        () => setRows([]),
      ),
    [query],
  );
  useEffect(load, [load]);
  const loadMore = () => more && query(more).then((r) => (setRows((x) => [...(x ?? []), ...r.issues]), setMore(r.nextCursor)));

  const columns: Column<Issue>[] = [
    { id: "level", header: t("issuesPage.level"), width: "96px", cell: (i) => <SeverityBadge severity={LEVEL[i.level]} /> },
    {
      id: "issue",
      header: t("issuesPage.issue"),
      width: "44%",
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <a href={`/issues/${i.id}`} className="errors-clamp font-medium" title={i.title}>
            {i.title}
          </a>
          <span className="errors-wrap font-mono text-xs text-fg-muted">{i.culprit ?? t("issuesPage.noStackTrace")}</span>
        </span>
      ),
    },
    { id: "status", header: t("issuesPage.status"), cell: (i) => <StatusLabel issue={i} /> },
    { id: "events", header: t("issuesPage.events"), align: "right", sortValue: (i) => i.events, cell: (i) => i.events },
    { id: "users", header: t("issuesPage.users"), align: "right", sortValue: (i) => i.users, cell: (i) => i.users },
    { id: "project", header: t("issuesPage.project"), cell: (i) => <span className="text-xs">{i.project.name}</span> },
    {
      id: "seen",
      header: t("issuesPage.lastSeen"),
      sortValue: (i) => i.lastSeen,
      cell: (i) => <span className="text-xs whitespace-nowrap">{ago(i.lastSeen)}</span>,
    },
  ];
  const s = summary;
  return (
    <>
      <PageHeader
        title={t("issuesPage.issues")}
        description={
          s
            ? t("issuesPage.inTheLastDayLast", {
                plural: t("plurals.project", { count: s.projects }),
                plural2: t("plurals.event", { count: s.events24h }),
                ago: ago(s.lastEventAt),
              })
            : undefined
        }
        actions={<SearchInput label={t("issuesPage.searchTitleOrCode")} className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />}
      />
      <Tabs<IssueStatus>
        label={t("issuesPage.issueViews")}
        value={tab}
        onChange={setTab}
        items={[
          { value: "unresolved", label: t("issuesPage.unresolved") },
          { value: "resolved", label: t("issuesPage.resolved") },
          { value: "ignored", label: t("issuesPage.ignored") },
        ]}
      />
      <FilterBar onClear={() => (setProject(""), setEnvironment(""), setRelease(""), setQ(""))}>
        <FacetFilter
          label={t("issuesPage.project")}
          selected={project ? [project] : []}
          onChange={(v) => setProject(v[v.length - 1] ?? "")}
          options={projects.map((p) => ({ value: p.id, label: p.name, count: p.unresolved }))}
        />
        <FacetFilter
          label={t("issuesPage.environment")}
          selected={environment ? [environment] : []}
          onChange={(v) => setEnvironment(v[v.length - 1] ?? "")}
          options={(summary?.environments ?? []).map((e) => ({ value: e }))}
        />
        <FacetFilter
          label={t("issuesPage.release")}
          selected={release ? [release] : []}
          onChange={(v) => setRelease(v[v.length - 1] ?? "")}
          options={releases.map((r) => ({ value: r.release, count: r.issues }))}
          searchable={releases.length > 8}
        />
      </FilterBar>
      <Panel
        title={tab === "unresolved" ? t("issuesPage.unresolved") : tab === "resolved" ? t("issuesPage.resolved") : t("issuesPage.ignored")}
        actions={
          <SegmentedControl
            label={t("issuesPage.sortBy")}
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: "lastSeen", label: t("issuesPage.lastSeen") },
              { value: "events", label: t("issuesPage.mostEvents") },
              { value: "users", label: t("issuesPage.mostUsers") },
              { value: "firstSeen", label: t("issuesPage.newest") },
            ]}
          />
        }
        flush
        footer={
          more ? (
            <Button size="sm" onClick={loadMore}>
              {t("issuesPage.loadMore")}
            </Button>
          ) : undefined
        }
      >
        <DataTable
          label={t("issuesPage.issues")}
          columns={columns}
          rows={rows ?? []}
          loading={!rows}
          getRowId={(i) => i.id}
          minWidth={900}
          pageSize={50}
          empty={
            <EmptyState title={tab === "unresolved" ? t("issuesPage.noUnresolvedIssues") : t("issuesPage.noIssues", { tab })}>
              {s && s.issues.unresolved + s.issues.resolved + s.issues.ignored === 0 ? (
                <>
                  {t("issuesPage.nothingHasBeenSentYet")} <a href="/setup">{t("issuesPage.setup")}</a>.
                </>
              ) : (
                t("issuesPage.nothingMatchesTheseFilters")
              )}
            </EmptyState>
          }
        />
      </Panel>
    </>
  );
}

function StackTrace({ frames }: { frames: Frame[] }) {
  const t = useT();
  // Most recent call first, the way people read a trace.
  const shown = [...frames].reverse();
  return (
    <ol className="errors-list flex flex-col gap-0.5 font-mono text-xs">
      {shown.map((f, n) => (
        <li key={n} className={f.in_app ? "text-fg" : "text-fg-muted"}>
          <span className="errors-wrap">
            {f.function ?? "?"}{" "}
            <span className="text-fg-muted">
              in {f.filename}
              {f.lineno ? `:${f.lineno}` : ""}
            </span>
          </span>
          {f.in_app && <Badge>{t("stackTrace.yourCode")}</Badge>}
        </li>
      ))}
    </ol>
  );
}

/** Events each day of the last 14, as a line. */
function DailyEvents({ label, days }: { label: string; days: EventDay[] }) {
  const t = useT();
  return (
    <TimeSeriesChart
      label={label}
      series={[{ id: "events", name: t("dailyEvents.events"), data: days.map((d) => d.events) }]}
      labels={days.map((d) => new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }))}
      height={140}
      xTicks={7}
    />
  );
}

function IssuePage({ call, id, reload }: { call: Call; id: string; reload: () => void }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [issue, setIssue] = useState<IssueDetail | null>();
  const [resolving, setResolving] = useState(false);
  const [release, setRelease] = useState("");
  const [error, setError] = useState<string>();
  const load = useCallback(() => void call<IssueDetail>(`/api/v1/issues/${id}`).then(setIssue, () => setIssue(null)), [call, id]);
  useEffect(load, [load]);

  const set = async (status: IssueStatus, rel?: string) => {
    try {
      await call(`/api/v1/issues/${id}`, { method: "PATCH", body: JSON.stringify({ status, ...(rel && { release: rel }) }) });
      setResolving(false);
      setError(undefined);
      load();
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = () =>
    call(`/api/v1/issues/${id}`, { method: "DELETE" }).then(
      () => (reload(), navigate("/issues")),
      (err: Error) => setError(err.message),
    );

  if (issue === null)
    return (
      <EmptyState title={t("issuePage.issueNotFound")}>
        {t("issuePage.itMayHaveBeenDeleted")} <a href="/issues">{t("issuePage.backToIssues")}</a>.
      </EmptyState>
    );
  const latest = issue?.latestEvents[0];
  return (
    <>
      <PageHeader
        title={issue?.title ?? t("issuePage.issue")}
        description={issue ? `${issue.project.name} · ${issue.culprit ?? t("issuesPage.noStackTrace")}` : undefined}
        actions={
          issue &&
          can("editor") && (
            <>
              {issue.status !== "resolved" && (
                <Button variant="primary" onClick={() => setResolving(true)}>
                  {t("issuePage.resolve")}
                </Button>
              )}
              {issue.status !== "ignored" && <Button onClick={() => void set("ignored")}>{t("issuePage.ignore")}</Button>}
              {issue.status !== "unresolved" && (
                <Button icon={<RefreshCw />} onClick={() => void set("unresolved")}>
                  {t("issuePage.reopen")}
                </Button>
              )}
              {can("admin") && (
                <Button icon={<Trash2 />} onClick={() => void remove()}>
                  {t("issuePage.delete")}
                </Button>
              )}
            </>
          )
        }
      />
      {error && <p className="m-0 text-sm text-danger">{error}</p>}
      {issue && (
        <>
          <KpiGrid minWidth={150}>
            <KpiCard label={t("issuePage.events")} value={issue.events} />
            <KpiCard label={t("issuePage.users")} value={issue.users} />
            <KpiCard label={t("issuePage.firstSeen")} value={ago(issue.firstSeen)} />
            <KpiCard label={t("issuePage.lastSeen")} value={ago(issue.lastSeen)} />
          </KpiGrid>
          <Panel title={t("issuePage.eventsOverTime")} description={t("issuePage.eachDayOfTheLast")}>
            <DailyEvents label={t("issuePage.eventsOfThisIssueEach")} days={issue.days} />
          </Panel>
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={LEVEL[issue.level]} />
            <StatusLabel issue={issue} />
            {issue.resolvedIn && <Badge>{t("issuePage.fixMeantFor", { resolvedIn: issue.resolvedIn })}</Badge>}
            {issue.regression && (
              <Badge tone="danger">
                {t("issuePage.cameBack")}
                {issue.regression.in ? t("issuePage.in", { in: issue.regression.in }) : ""}
              </Badge>
            )}
            {issue.environments.map((e) => (
              <Badge key={e}>{e}</Badge>
            ))}
          </div>
          <Panel
            title={t("issuePage.latestEvent")}
            description={
              latest
                ? `${ago(latest.timestamp)}${latest.release ? ` · release ${latest.release}` : ""} · ${latest.environment}${latest.user ? ` · user ${latest.user.id}` : ""}`
                : undefined
            }
          >
            {latest?.exception ? (
              <div className="flex flex-col gap-2">
                <span className="errors-wrap font-mono text-sm font-medium">
                  {latest.exception.type}
                  {latest.exception.value ? `: ${latest.exception.value}` : ""}
                </span>
                {latest.exception.frames.length ? (
                  <StackTrace frames={latest.exception.frames} />
                ) : (
                  <span className="text-sm text-fg-muted">{t("issuePage.noStackTraceWasSent")}</span>
                )}
              </div>
            ) : (
              <Code>{latest?.message ?? ""}</Code>
            )}
            {latest?.request && (
              <p className="mt-2 mb-0 text-xs text-fg-muted">
                {latest.request.method ?? t("issuePage.request")} {latest.request.url}
              </p>
            )}
            {latest && Object.keys(latest.tags).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {Object.entries(latest.tags).map(([k, v]) => (
                  <Badge key={k} mono>
                    {k}: {v}
                  </Badge>
                ))}
              </div>
            )}
          </Panel>
          <Panel title={t("issuePage.releases")} description={t("issuePage.whereThisIssueAppeared")} flush>
            <DataTable
              label={t("issuePage.releasesOfThisIssue")}
              columns={[
                { id: "r", header: t("issuePage.release"), mono: true, cell: (r) => r.release },
                { id: "e", header: t("issuePage.events"), align: "right", cell: (r) => r.events },
                { id: "f", header: t("issuePage.firstSeen"), cell: (r) => <span className="text-xs">{ago(r.firstSeen)}</span> },
                { id: "l", header: t("issuePage.lastSeen"), cell: (r) => <span className="text-xs">{ago(r.lastSeen)}</span> },
              ]}
              rows={issue.releases}
              getRowId={(r) => r.release}
              minWidth={480}
              empty={<EmptyState title={t("issuePage.noRelease")}>{t("issuePage.eventsWereSentWithoutA")}</EmptyState>}
            />
          </Panel>
          <Panel title={t("issuePage.events")} description={t("issuePage.theLatestOlderOnesAre", { length: issue.latestEvents.length })} flush>
            <DataTable
              label={t("issuePage.latestEvents")}
              columns={[
                { id: "t", header: t("issuePage.when"), cell: (e) => <span className="text-xs whitespace-nowrap">{ago(e.timestamp)}</span> },
                { id: "m", header: t("issuePage.message"), cell: (e) => <span className="errors-clamp text-xs">{e.exception?.value ?? e.message ?? ""}</span> },
                { id: "r", header: t("issuePage.release"), mono: true, cell: (e) => e.release ?? "–" },
                { id: "n", header: t("issuePage.environment"), cell: (e) => e.environment },
                { id: "u", header: t("issuePage.user"), mono: true, cell: (e) => e.user?.id ?? "–" },
              ]}
              rows={issue.latestEvents}
              getRowId={(e) => e.id}
              minWidth={700}
            />
          </Panel>
        </>
      )}
      <Dialog
        open={resolving}
        onOpenChange={setResolving}
        title={t("issuePage.resolveThisIssue")}
        description={t("issuePage.ifItHappensAgainIt")}
        onSubmit={(e: FormEvent) => (e.preventDefault(), void set("resolved", release.trim() || undefined))}
        footer={
          <>
            <Button type="button" onClick={() => setResolving(false)}>
              {t("issuePage.cancel")}
            </Button>
            <Button type="submit" variant="primary">
              {t("issuePage.resolve")}
            </Button>
          </>
        }
      >
        <TextField
          label={t("issuePage.fixedInRelease")}
          value={release}
          onChange={(e) => setRelease(e.target.value)}
          hint={t("issuePage.optionalForExample14")}
        />
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- Projects

function ProjectsPage({ call, reload }: { call: Call; reload: () => void }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [rows, setRows] = useState<Project[]>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState<Project>();
  const load = useCallback(
    () =>
      void call<{ projects: Project[] }>("/api/v1/projects?limit=500").then(
        (r) => setRows(r.projects),
        () => setRows([]),
      ),
    [call],
  );
  useEffect(load, [load]);
  const close = () => (setAdding(false), setName(""), setError(undefined));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await call<Project>("/api/v1/projects", { method: "POST", body: JSON.stringify({ name }) });
      close();
      setShown(p);
      load();
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const rotate = (p: Project) =>
    call<Project>(`/api/v1/projects/${p.id}/key`, { method: "POST" }).then(
      (r) => (setShown(r), load()),
      () => {},
    );
  const remove = (p: Project) =>
    call(`/api/v1/projects/${p.id}`, { method: "DELETE" }).then(
      () => (load(), reload()),
      () => {},
    );

  const columns: Column<Project>[] = [
    { id: "name", header: t("projectsPage.project"), sortValue: (p) => p.name, cell: (p) => <span className="font-medium">{p.name}</span> },
    { id: "key", header: t("projectsPage.key"), mono: true, cell: (p) => `${p.keyPrefix}…` },
    { id: "rate", header: t("projectsPage.eventsAMinute"), align: "right", cell: (p) => p.rateLimit },
    { id: "open", header: t("projectsPage.unresolved"), align: "right", cell: (p) => p.unresolved },
    { id: "last", header: t("projectsPage.lastEvent"), cell: (p) => <span className="text-xs">{ago(p.lastEventAt)}</span> },
    {
      id: "actions",
      header: <span className="sr-only">{t("projectsPage.actions")}</span>,
      label: t("projectsPage.actions"),
      align: "right",
      cell: (p) =>
        can("admin") && (
          <span className="flex justify-end gap-1">
            <Button size="sm" icon={<KeyRound />} onClick={() => void rotate(p)}>
              {t("projectsPage.newKey")}
            </Button>
            <Button size="sm" icon={<Trash2 />} onClick={() => void remove(p)}>
              {t("projectsPage.delete")}
            </Button>
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("projectsPage.projects")}
        description={t("projectsPage.onePerApplicationItsKey")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("projectsPage.addProject")}
            </Button>
          )
        }
      />
      <Panel flush>
        <DataTable
          label={t("projectsPage.projects")}
          columns={columns}
          rows={rows ?? []}
          loading={!rows}
          getRowId={(p) => p.id}
          minWidth={760}
          empty={
            <EmptyState title={t("projectsPage.noProjectsYet")}>
              {can("admin") ? t("projectsPage.addTheFirstApplication") : t("projectsPage.anAdminAddsTheApplications")}
            </EmptyState>
          }
        />
      </Panel>
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        title={t("projectsPage.addAProject")}
        description={t("projectsPage.youGetItsKeyNext")}
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              {t("projectsPage.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              {t("projectsPage.addProject")}
            </Button>
          </>
        }
      >
        <TextField
          label={t("projectsPage.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint={t("projectsPage.lettersDigitsAnd")}
          error={error}
        />
      </Dialog>
      <Dialog
        open={!!shown}
        onOpenChange={(open) => !open && setShown(undefined)}
        title={t("projectsPage.keyFor", { value: shown?.name ?? "" })}
        description={t("projectsPage.copyItNowItIs")}
        footer={
          <Button type="button" variant="primary" onClick={() => setShown(undefined)}>
            {t("projectsPage.done")}
          </Button>
        }
      >
        <Code>{shown?.key}</Code>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- Setup

function SetupPage() {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.sendErrorsFromYourApplication")} />
      <Panel title={t("setupPage.sendAnEvent")} description={t("setupPage.useAProjectSKey")}>
        <Code>{`curl -sf -X POST ${origin}/api/v1/events -H "x-errors-key: $ERRORS_KEY" -H 'content-type: application/json' -d '{
  "release": "1.4.2", "environment": "production", "user": {"id": "u-42"},
  "exception": {
    "type": "TypeError", "value": "x is undefined",
    "frames": [{"filename": "src/cart.js", "function": "total", "lineno": 12, "in_app": true}]
  }
}'`}</Code>
      </Panel>
      <Panel title={t("setupPage.howEventsBecomeIssues")} description={t("setupPage.eventsWithTheSameCause")}>
        <ul className="errors-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>{t("setupPage.theCauseIsTheException")}</li>
          <li>{t("setupPage.framesAreListedWithThe")}</li>
          <li>{t("setupPage.resolveAnIssueWithThe")}</li>
          <li>{t("setupPage.passwordsTokensAndKeysIn")}</li>
          <li>{t("setupPage.eachIssueKeepsItsLatest")}</li>
        </ul>
      </Panel>
    </>
  );
}

/** The first screen, until the first project exists. The summary is polled, so it gives way by itself. */
function WelcomePage() {
  const t = useT();
  return (
    <>
      <PageHeader
        title={t("welcomePage.getStarted")}
        description={t("welcomePage.addAProjectCopyIts")}
        actions={<StatusBadge tone="info">{t("welcomePage.waitingForTheFirstProject")}</StatusBadge>}
      />
      <SetupPage />
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdminOfThis")}</EmptyState>;
  const titles = {
    account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
    members: [
      "Members",
      "Who can sign in to this errors, and with which role. Viewers see everything; editors also resolve and ignore issues; admins also manage projects, members and tokens.",
    ],
    signin: [
      "Sign-in",
      "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role.",
    ],
    tokens: ["API tokens", "For scripts. Each token has one role and an expiry; the secret is shown once."],
  } as const;
  return (
    <>
      <PageHeader
        title={titles[page][0]}
        description={titles[page][1]}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "errors" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "overview", label: msg("product.overview"), icon: LayoutDashboard },
    { id: "issues", label: msg("product.issues"), icon: Bug, count: summary?.issues.unresolved },
    { id: "projects", label: msg("product.projects"), icon: FolderKanban, count: summary?.projects },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const active = route.page === "issue" ? "issues" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="errors"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {(route.page === "overview" || route.page === "issues") && summary && summary.projects === 0 ? (
        <WelcomePage />
      ) : route.page === "overview" ? (
        <OverviewPage call={call} summary={summary} />
      ) : route.page === "issues" ? (
        <IssuesPage call={call} summary={summary} />
      ) : route.page === "issue" ? (
        <IssuePage key={route.id} call={call} id={route.id} reload={reload} />
      ) : route.page === "projects" ? (
        <ProjectsPage call={call} reload={reload} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <SettingsPage page={route.page} />
      ) : (
        <SetupPage />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Errors">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
