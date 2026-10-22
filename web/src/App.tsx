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
  SelectField,
  SeverityBadge,
  StatusBadge,
  Tabs,
  TextField,
  usePath,
  type Column,
  type ProductId,
  type Severity as UiSeverity,
  useThemePreference,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { Bug, FolderKanban, KeyRound, LogIn, LogOut, Plus, RefreshCw, Settings2, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Frame, type Issue, type IssueDetail, type IssueStatus, type Level, type ProductLink, type Project, type Summary } from "./api.ts";

// Five levels of an application become the shared scale of four plus info.
const LEVEL: Record<Level, UiSeverity> = { fatal: "critical", error: "high", warning: "medium", info: "low", debug: "info" };

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const PAGES = ["projects", "setup", "account", "members", "signin", "tokens"] as const;
type Route = { page: "issues" | (typeof PAGES)[number] } | { page: "issue"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["issues", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "issues" && id) return { page: "issue", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "issues" };
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
  if (issue.regression && issue.status === "unresolved") return <StatusBadge tone="danger">Regression</StatusBadge>;
  if (issue.status === "resolved") return <StatusBadge tone="success">Resolved</StatusBadge>;
  if (issue.status === "ignored") return <StatusBadge tone="neutral">Ignored</StatusBadge>;
  return <StatusBadge tone="warning">Unresolved</StatusBadge>;
}

// ---------------------------------------------------------------- Issues

type Sort = "lastSeen" | "events" | "users" | "firstSeen";

function IssuesPage({ call, summary }: { call: Call; summary?: Summary }) {
  const [tab, setTab] = useState<IssueStatus>("unresolved");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [environment, setEnvironment] = useState("");
  const [release, setRelease] = useState("");
  const [sort, setSort] = useState<Sort>("lastSeen");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Issue[]>();
  const [more, setMore] = useState<string>();
  useEffect(() => void call<{ projects: Project[] }>("/api/v1/projects?limit=500").then((r) => setProjects(r.projects), () => {}), [call]);

  const query = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams({ status: tab, sort, limit: "100" });
      if (project) p.set("project", project);
      if (environment.trim()) p.set("environment", environment.trim());
      if (release.trim()) p.set("release", release.trim());
      if (q.trim()) p.set("q", q.trim());
      if (cursor) p.set("cursor", cursor);
      return call<{ issues: Issue[]; nextCursor?: string }>(`/api/v1/issues?${p}`);
    },
    [call, tab, sort, project, environment, release, q],
  );
  const load = useCallback(() => void query().then((r) => (setRows(r.issues), setMore(r.nextCursor)), () => setRows([])), [query]);
  useEffect(load, [load]);
  const loadMore = () => more && query(more).then((r) => (setRows((x) => [...(x ?? []), ...r.issues]), setMore(r.nextCursor)));

  const columns: Column<Issue>[] = [
    { id: "level", header: "Level", width: "96px", cell: (i) => <SeverityBadge severity={LEVEL[i.level]} /> },
    {
      id: "issue",
      header: "Issue",
      width: "44%",
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <a href={`/issues/${i.id}`} className="errors-clamp font-medium" title={i.title}>
            {i.title}
          </a>
          <span className="errors-wrap font-mono text-xs text-fg-muted">{i.culprit ?? "no stack trace"}</span>
        </span>
      ),
    },
    { id: "status", header: "Status", cell: (i) => <StatusLabel issue={i} /> },
    { id: "events", header: "Events", align: "right", sortValue: (i) => i.events, cell: (i) => i.events },
    { id: "users", header: "Users", align: "right", sortValue: (i) => i.users, cell: (i) => i.users },
    { id: "project", header: "Project", cell: (i) => <span className="text-xs">{i.project.name}</span> },
    { id: "seen", header: "Last seen", sortValue: (i) => i.lastSeen, cell: (i) => <span className="text-xs whitespace-nowrap">{ago(i.lastSeen)}</span> },
  ];
  const s = summary;
  return (
    <>
      <PageHeader title="Issues" description={s ? `${plural(s.projects, "project")} · ${plural(s.events24h, "event")} in the last day · last event ${ago(s.lastEventAt)}` : undefined} actions={<SearchInput label="Search title or code" className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />} />
      {s && (
        <KpiGrid minWidth={150}>
          <KpiCard label="Unresolved" value={s.issues.unresolved} tone={s.issues.unresolved ? "warning" : "success"} />
          <KpiCard label="Regressions" value={s.regressions} tone={s.regressions ? "danger" : "success"} />
          <KpiCard label="Resolved" value={s.issues.resolved} />
          <KpiCard label="Ignored" value={s.issues.ignored} />
          <KpiCard label="Events, 24 hours" value={s.events24h} tone="info" />
        </KpiGrid>
      )}
      <Tabs<IssueStatus>
        label="Issue views"
        value={tab}
        onChange={setTab}
        items={[
          { value: "unresolved", label: "Unresolved" },
          { value: "resolved", label: "Resolved" },
          { value: "ignored", label: "Ignored" },
        ]}
      />
      <FilterBar onClear={() => (setProject(""), setEnvironment(""), setRelease(""), setQ(""))}>
        <FacetFilter label="Project" selected={project ? [project] : []} onChange={(v) => setProject(v[v.length - 1] ?? "")} options={projects.map((p) => ({ value: p.id, label: p.name, count: p.unresolved }))} />
        <TextField label="Environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
        <TextField label="Release" value={release} onChange={(e) => setRelease(e.target.value)} />
        <SelectField
          label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          options={[
            { value: "lastSeen", label: "Last seen" },
            { value: "events", label: "Most events" },
            { value: "users", label: "Most users" },
            { value: "firstSeen", label: "Newest" },
          ]}
        />
      </FilterBar>
      <Panel
        title={tab === "unresolved" ? "Unresolved" : tab === "resolved" ? "Resolved" : "Ignored"}
        flush
        footer={
          more ? (
            <Button size="sm" onClick={loadMore}>
              Load more
            </Button>
          ) : undefined
        }
      >
        <DataTable
          label="Issues"
          columns={columns}
          rows={rows ?? []}
          loading={!rows}
          getRowId={(i) => i.id}
          minWidth={900}
          pageSize={50}
          empty={
            <EmptyState title={tab === "unresolved" ? "No unresolved issues" : `No ${tab} issues`}>
              {s && s.issues.unresolved + s.issues.resolved + s.issues.ignored === 0 ? (
                <>
                  Nothing has been sent yet. See <a href="/setup">Setup</a>.
                </>
              ) : (
                "Nothing matches these filters."
              )}
            </EmptyState>
          }
        />
      </Panel>
    </>
  );
}

function StackTrace({ frames }: { frames: Frame[] }) {
  // Most recent call first, the way people read a trace.
  const shown = [...frames].reverse();
  return (
    <ol className="errors-list flex flex-col gap-0.5 font-mono text-xs">
      {shown.map((f, n) => (
        <li key={n} className={f.in_app ? "text-fg" : "text-fg-muted"}>
          <span className="errors-wrap">
            {f.function ?? "?"} <span className="text-fg-muted">in {f.filename}{f.lineno ? `:${f.lineno}` : ""}</span>
          </span>
          {f.in_app && <Badge>your code</Badge>}
        </li>
      ))}
    </ol>
  );
}

function IssuePage({ call, id, reload }: { call: Call; id: string; reload: () => void }) {
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
  const remove = () => call(`/api/v1/issues/${id}`, { method: "DELETE" }).then(() => (reload(), navigate("/issues")), (err: Error) => setError(err.message));

  if (issue === null)
    return (
      <EmptyState title="Issue not found">
        It may have been deleted, or have aged out. <a href="/issues">Back to issues</a>.
      </EmptyState>
    );
  const latest = issue?.latestEvents[0];
  return (
    <>
      <PageHeader
        title={issue?.title ?? "Issue"}
        description={issue ? `${issue.project.name} · ${issue.culprit ?? "no stack trace"}` : undefined}
        actions={
          issue &&
          can("editor") && (
            <>
              {issue.status !== "resolved" && (
                <Button variant="primary" onClick={() => setResolving(true)}>
                  Resolve
                </Button>
              )}
              {issue.status !== "ignored" && <Button onClick={() => void set("ignored")}>Ignore</Button>}
              {issue.status !== "unresolved" && (
                <Button icon={<RefreshCw />} onClick={() => void set("unresolved")}>
                  Reopen
                </Button>
              )}
              {can("admin") && (
                <Button icon={<Trash2 />} onClick={() => void remove()}>
                  Delete
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
            <KpiCard label="Events" value={issue.events} />
            <KpiCard label="Users" value={issue.users} />
            <KpiCard label="First seen" value={ago(issue.firstSeen)} />
            <KpiCard label="Last seen" value={ago(issue.lastSeen)} />
          </KpiGrid>
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={LEVEL[issue.level]} />
            <StatusLabel issue={issue} />
            {issue.resolvedIn && <Badge>fix meant for {issue.resolvedIn}</Badge>}
            {issue.regression && <Badge tone="danger">came back{issue.regression.in ? ` in ${issue.regression.in}` : ""}</Badge>}
            {issue.environments.map((e) => (
              <Badge key={e}>{e}</Badge>
            ))}
          </div>
          <Panel title="Latest event" description={latest ? `${ago(latest.timestamp)}${latest.release ? ` · release ${latest.release}` : ""} · ${latest.environment}${latest.user ? ` · user ${latest.user.id}` : ""}` : undefined}>
            {latest?.exception ? (
              <div className="flex flex-col gap-2">
                <span className="errors-wrap font-mono text-sm font-medium">
                  {latest.exception.type}
                  {latest.exception.value ? `: ${latest.exception.value}` : ""}
                </span>
                {latest.exception.frames.length ? <StackTrace frames={latest.exception.frames} /> : <span className="text-sm text-fg-muted">No stack trace was sent.</span>}
              </div>
            ) : (
              <Code>{latest?.message ?? ""}</Code>
            )}
            {latest?.request && (
              <p className="mt-2 mb-0 text-xs text-fg-muted">
                {latest.request.method ?? "Request"} {latest.request.url}
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
          <Panel title="Releases" description="Where this issue appeared" flush>
            <DataTable
              label="Releases of this issue"
              columns={[
                { id: "r", header: "Release", mono: true, cell: (r) => r.release },
                { id: "e", header: "Events", align: "right", cell: (r) => r.events },
                { id: "f", header: "First seen", cell: (r) => <span className="text-xs">{ago(r.firstSeen)}</span> },
                { id: "l", header: "Last seen", cell: (r) => <span className="text-xs">{ago(r.lastSeen)}</span> },
              ]}
              rows={issue.releases}
              getRowId={(r) => r.release}
              minWidth={480}
              empty={<EmptyState title="No release">Events were sent without a release.</EmptyState>}
            />
          </Panel>
          <Panel title="Events" description={`The latest ${issue.latestEvents.length}; older ones are counted and dropped`} flush>
            <DataTable
              label="Latest events"
              columns={[
                { id: "t", header: "When", cell: (e) => <span className="text-xs whitespace-nowrap">{ago(e.timestamp)}</span> },
                { id: "m", header: "Message", cell: (e) => <span className="errors-clamp text-xs">{e.exception?.value ?? e.message ?? ""}</span> },
                { id: "r", header: "Release", mono: true, cell: (e) => e.release ?? "–" },
                { id: "n", header: "Environment", cell: (e) => e.environment },
                { id: "u", header: "User", mono: true, cell: (e) => e.user?.id ?? "–" },
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
        title="Resolve this issue"
        description="If it happens again, it is reopened as a regression. Say which release ships the fix, so the page can tell a fix that did not hold from one that has not shipped."
        onSubmit={(e: FormEvent) => (e.preventDefault(), void set("resolved", release.trim() || undefined))}
        footer={
          <>
            <Button type="button" onClick={() => setResolving(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Resolve
            </Button>
          </>
        }
      >
        <TextField label="Fixed in release" value={release} onChange={(e) => setRelease(e.target.value)} hint="Optional, for example 1.4.3." />
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- Projects

function ProjectsPage({ call, reload }: { call: Call; reload: () => void }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<Project[]>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState<Project>();
  const load = useCallback(() => void call<{ projects: Project[] }>("/api/v1/projects?limit=500").then((r) => setRows(r.projects), () => setRows([])), [call]);
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
  const rotate = (p: Project) => call<Project>(`/api/v1/projects/${p.id}/key`, { method: "POST" }).then((r) => (setShown(r), load()), () => {});
  const remove = (p: Project) => call(`/api/v1/projects/${p.id}`, { method: "DELETE" }).then(() => (load(), reload()), () => {});

  const columns: Column<Project>[] = [
    { id: "name", header: "Project", sortValue: (p) => p.name, cell: (p) => <span className="font-medium">{p.name}</span> },
    { id: "key", header: "Key", mono: true, cell: (p) => `${p.keyPrefix}…` },
    { id: "rate", header: "Events a minute", align: "right", cell: (p) => p.rateLimit },
    { id: "open", header: "Unresolved", align: "right", cell: (p) => p.unresolved },
    { id: "last", header: "Last event", cell: (p) => <span className="text-xs">{ago(p.lastEventAt)}</span> },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      label: "Actions",
      align: "right",
      cell: (p) =>
        can("admin") && (
          <span className="flex justify-end gap-1">
            <Button size="sm" icon={<KeyRound />} onClick={() => void rotate(p)}>
              New key
            </Button>
            <Button size="sm" icon={<Trash2 />} onClick={() => void remove(p)}>
              Delete
            </Button>
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Projects"
        description="One per application. Its key is what the application sends events with."
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add project
            </Button>
          )
        }
      />
      <Panel flush>
        <DataTable label="Projects" columns={columns} rows={rows ?? []} loading={!rows} getRowId={(p) => p.id} minWidth={760} empty={<EmptyState title="No projects yet">{can("admin") ? "Add the first application." : "An admin adds the applications that send events."}</EmptyState>} />
      </Panel>
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        title="Add a project"
        description="You get its key next, once."
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              Add project
            </Button>
          </>
        }
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} hint="Letters, digits, . _ and -." error={error} />
      </Dialog>
      <Dialog
        open={!!shown}
        onOpenChange={(open) => !open && setShown(undefined)}
        title={`Key for ${shown?.name ?? ""}`}
        description="Copy it now. It is kept only as a hash, and cannot be shown again. A new key stops this one at once."
        footer={
          <Button type="button" variant="primary" onClick={() => setShown(undefined)}>
            Done
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
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title="Setup" description="Send errors from your application with one HTTP request. No SDK is needed." />
      <Panel title="Send an event" description="Use a project's key, from Projects. The body may be gzipped.">
        <Code>{`curl -sf -X POST ${origin}/api/v1/events -H "x-errors-key: $ERRORS_KEY" -H 'content-type: application/json' -d '{
  "release": "1.4.2", "environment": "production", "user": {"id": "u-42"},
  "exception": {
    "type": "TypeError", "value": "x is undefined",
    "frames": [{"filename": "src/cart.js", "function": "total", "lineno": 12, "in_app": true}]
  }
}'`}</Code>
      </Panel>
      <Panel title="How events become issues" description="Events with the same cause are one issue.">
        <ul className="errors-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>The cause is the exception type and the last three frames of your own code (`in_app`), without line numbers, so a deploy does not split an issue. Without frames, it is the message with numbers and quoted text ignored. Send `fingerprint` to decide yourself.</li>
          <li>Frames are listed with the most recent call last.</li>
          <li>Resolve an issue with the release that ships the fix. If it happens again it is reopened as a regression.</li>
          <li>Passwords, tokens and keys in messages and tags are masked. Request bodies, headers, cookies and personal data about users are not accepted.</li>
          <li>Each issue keeps its latest 20 events. A project that sends more events a minute than its limit gets 429 with Retry-After.</li>
        </ul>
      </Panel>
    </>
  );
}

/** The first screen, until the first project exists. The summary is polled, so it gives way by itself. */
function WelcomePage() {
  return (
    <>
      <PageHeader title="Get started" description="Add a project, copy its key, and send an event." actions={<StatusBadge tone="info">Waiting for the first project</StatusBadge>} />
      <SetupPage />
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title="Admins only">Ask an admin of this errors for access.</EmptyState>;
  const titles = {
    account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
    members: ["Members", "Who can sign in to this errors, and with which role. Viewers see everything; editors also resolve and ignore issues; admins also manage projects, members and tokens."],
    signin: ["Sign-in", "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role."],
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
              Sign out
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const [theme, setTheme] = useThemePreference();
  const { me, can } = useAuth();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "errors" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
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
    { id: "issues", label: "Issues", icon: Bug, count: summary?.issues.unresolved },
    { id: "projects", label: "Projects", icon: FolderKanban, count: summary?.projects },
  ];
  const footerNav = [
    { id: "setup", label: "Setup", icon: Settings2 },
    ...(can("admin")
      ? [
          { id: "members", label: "Members", icon: Users },
          { id: "signin", label: "Sign-in", icon: LogIn },
          { id: "tokens", label: "API tokens", icon: KeyRound },
        ]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  const active = route.page === "issue" ? "issues" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="errors"
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
      theme={theme}
      onThemeChange={setTheme}
    >
      {route.page === "issues" && summary && summary.projects === 0 ? (
        <WelcomePage />
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
  const [theme] = useThemePreference();
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider theme={theme} brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy Errors">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
