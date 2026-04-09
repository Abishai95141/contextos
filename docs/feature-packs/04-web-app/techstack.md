# Feature Pack 04: Web Application — Technology Choices and Rationale

## 1. Next.js 15 App Router, React 19, Server Components

### Why Next.js App Router (Not Pages Router, Not SPA)

ContextOS's web app has a specific access pattern: most pages fetch data for the authenticated user's organization and render it server-side. The App Router's Server Components fit this pattern precisely:

- **Dashboard page**: Fetches project list, run counts, pack counts — all in a single server-side query. No client-side loading state. The page renders complete HTML.
- **Pack editor**: Static metadata (pack name, version) is server-rendered; the interactive editor is a Client Component nested inside.
- **Run history**: List is server-rendered; live SSE updates for active runs are handled by Client Components.

With Pages Router (or a pure SPA), every page would require a loading state and client-side data fetch — more JavaScript, slower initial render, and complex state management for what is fundamentally "get data → render data".

### React 19 Server Components

React 19's async Server Components allow direct database queries in component bodies:

```typescript
// This is a valid React 19 Server Component
export default async function DashboardPage() {
  const orgId = await requireOrgId();
  const projects = await getDb()
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.clerkOrgId, orgId));

  return <ProjectList projects={projects} />;
}
```

No API route, no `useEffect`, no loading spinner for the initial data. The HTML arrives fully populated. This pattern is used for every read-only page in ContextOS.

### Selective Client Components

Client Components are used only when interactivity is required:
- `PackEditor` — form state, save action, unsaved changes warning
- `ContextArchive` — search input, debounce, SWR data fetching
- `RunTimeline` — SSE connection for live run updates
- `PolicyRuleTable` — drag-to-reorder, inline editing

Client Components are nested inside Server Component pages. The Server Component fetches the initial data; the Client Component takes over for interactions. This minimizes client-side JavaScript to only what's necessary.

### Why Not Remix?

Remix is an excellent React framework with a similarly server-centric philosophy. The primary reason for Next.js over Remix for ContextOS:

- **Clerk integration**: Clerk's `@clerk/nextjs` package has first-class Next.js App Router support. Clerk's Remix support is available but newer and less thoroughly documented.
- **Turborepo compatibility**: Next.js has official Turborepo examples and well-tested pnpm workspace integration. The `turbo prune` → Docker build pattern works reliably with Next.js.
- **Ecosystem**: More components, libraries, and UI primitives are built for Next.js first.

---

## 2. Tailwind CSS v4

### Why Tailwind

Tailwind CSS utility classes directly in JSX eliminate the overhead of naming CSS classes, creating separate CSS files, and managing specificity. For a dashboard-heavy app like ContextOS, the productivity gain is significant.

Tailwind v4 (2025) introduces:
- **CSS-first configuration**: The `tailwind.config.js` is replaced by CSS `@import 'tailwindcss'` with theme customization in CSS variables. Less JavaScript config overhead.
- **Lightning CSS integration**: v4 uses Lightning CSS for transforms, resulting in 5x faster builds than v3.
- **Automatic content detection**: No more `content: ['./app/**/*.tsx']` configuration. v4 detects files automatically.

### Design System Approach

The ContextOS web app uses a minimal color system:
- Primary accent: teal (`#01696F`) — used for interactive elements, CTAs, active states
- Neutral grays: Tailwind's `gray-50` through `gray-900` — backgrounds, borders, text
- Semantic colors: `red` for errors/danger, `green` for success/healthy, `yellow` for warnings

All interactive elements have clear hover states, focus rings, and disabled states. Accessibility is maintained via Tailwind's `focus-visible:` and `aria-` utilities.

---

## 3. Clerk for Authentication

### Why Clerk Over Auth.js or Custom

ContextOS needs organization management — not just user authentication. Clerk provides:

1. **Organization management out of the box**: Users can belong to multiple orgs, orgs can have members with roles (admin/member), orgs can be created and deleted.
2. **`@clerk/nextjs` App Router integration**: `auth()` function works in Server Components, API routes, and middleware without any wrapper. `clerkMiddleware()` is a single line.
3. **M2M tokens**: Clerk can generate machine-to-machine JWT tokens for the MCP Server and Hooks Bridge. The MCP server validates these with `verifyToken()` in one function call.
4. **Webhooks with Svix signatures**: All org lifecycle events (create, delete, member add/remove) arrive via signed webhooks. The `svix` library verifies signatures in one line.

Auth.js (NextAuth) would require building organization management from scratch on top of a standard user table — weeks of work that Clerk provides as a feature.

### Server-Side Auth Pattern

In Server Components:
```typescript
import { auth } from '@clerk/nextjs/server';
const { orgId, userId } = await auth();
```

In API routes:
```typescript
import { auth } from '@clerk/nextjs/server';
const { orgId } = await auth();
if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
```

In middleware:
```typescript
import { clerkMiddleware } from '@clerk/nextjs/server';
export default clerkMiddleware((auth, req) => { ... });
```

The consistent API across all Next.js contexts removes cognitive overhead.

---

## 4. SWR for Client-Side Data Fetching

### Why SWR Over TanStack Query

SWR (stale-while-revalidate) is the data fetching library of choice for ContextOS's Client Components:

- **Simpler API**: `useSWR(key, fetcher)` — that's the core API. TanStack Query has more features but requires more setup (`QueryClient`, `QueryClientProvider`, cache configuration).
- **Next.js team's library**: SWR is built by Vercel and is optimized for Next.js patterns. It integrates naturally with Next.js's incremental static regeneration and streaming.
- **Deduplication**: Multiple components using the same key share a single fetch request. In the dashboard, if three components fetch `/api/projects`, SWR makes one HTTP request and distributes the result.
- **Stale-while-revalidate**: The UI shows cached data immediately and revalidates in the background — the right default for ContextOS's data (run history, pack list) which changes on a human timescale.

TanStack Query is the better choice when complex mutation workflows, optimistic updates, or infinite scroll are needed. ContextOS's Client Components have simple read patterns where SWR is sufficient.

### Usage in Context Archive

```typescript
const { data, isLoading } = useSWR(
  `/api/context?projectId=${projectId}&q=${query}`,
  fetcher,
  { keepPreviousData: true }, // Shows old results while new query is loading
);
```

The `keepPreviousData: true` option is key for search — as the user types, old results remain visible rather than showing a loading spinner for every keystroke. The spinner only appears on the first load.

---

## 5. Server-Sent Events for Live Run Updates

### Why SSE Over WebSockets

Active runs need live updates (new event count, current tool name). SSE provides:
- **Simpler infrastructure**: SSE is plain HTTP. No WebSocket upgrade, no `ws://` protocol, no load balancer configuration for WebSocket sticky sessions.
- **Next.js compatible**: Next.js App Router's `Response` with `ReadableStream` supports SSE natively. No additional server required.
- **One-directional**: Run updates flow server → client only. SSE is exactly right for this; WebSockets add bidirectional complexity that isn't needed.
- **Automatic reconnection**: The browser `EventSource` API reconnects automatically if the connection drops. No client-side reconnection logic needed.

The SSE polling interval is 2 seconds — fast enough for real-time feel, slow enough not to hammer the database. For completed runs, the SSE connection is closed after the completion event is sent.

### Fallback for Completed Runs

If a user navigates to a run that completed before they opened the page, SSE still works — it emits one event with the final state and then closes. The Client Component handles both cases (initial state from Server Component props + live updates from SSE).
