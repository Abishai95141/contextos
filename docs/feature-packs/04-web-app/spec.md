# Feature Pack 04: Web Application

## Overview

The ContextOS web application is the management interface for the entire platform. Users manage Feature Packs, view Context Pack archives with semantic search, monitor run history, configure policy rules, and see a project health dashboard. The app is built on Next.js 15 App Router with React 19 Server Components.

---

## 1. Architecture

```
Browser
  │
  │  HTTPS
  ▼
Next.js 15 App Router (apps/web)
  │
  ├── app/ (App Router)
  │   ├── (auth)/
  │   │   ├── sign-in/   → Clerk sign-in page
  │   │   └── sign-up/   → Clerk sign-up page
  │   │
  │   ├── dashboard/
  │   │   ├── page.tsx           → Project list + health overview
  │   │   ├── [projectSlug]/
  │   │   │   ├── page.tsx               → Project dashboard
  │   │   │   ├── packs/
  │   │   │   │   ├── page.tsx           → Feature Pack list
  │   │   │   │   ├── [packId]/
  │   │   │   │   │   ├── page.tsx       → Feature Pack editor
  │   │   │   │   │   └── versions/      → Version history
  │   │   │   ├── context/
  │   │   │   │   ├── page.tsx           → Context Pack archive + search
  │   │   │   │   └── [contextId]/
  │   │   │   │       └── page.tsx       → Context Pack detail + diff viewer
  │   │   │   ├── runs/
  │   │   │   │   ├── page.tsx           → Run history timeline
  │   │   │   │   └── [runId]/
  │   │   │   │       └── page.tsx       → Run detail + event log
  │   │   │   ├── policy/
  │   │   │   │   ├── page.tsx           → Policy rule manager
  │   │   │   │   └── new/
  │   │   │   │       └── page.tsx       → New rule form
  │   │   │   └── settings/
  │   │   │       └── page.tsx           → Project settings + hook config
  │   │
  ├── api/
  │   ├── projects/
  │   │   ├── route.ts           → GET (list), POST (create)
  │   │   └── [slug]/
  │   │       └── route.ts       → GET (detail), PATCH, DELETE
  │   ├── packs/[packId]/
  │   │   ├── route.ts           → GET, PATCH, DELETE
  │   │   └── versions/route.ts  → GET version history
  │   ├── context/
  │   │   ├── route.ts           → GET (list + search), POST
  │   │   └── [id]/route.ts      → GET detail
  │   ├── runs/
  │   │   ├── route.ts           → GET (list)
  │   │   └── [id]/
  │   │       ├── route.ts       → GET detail
  │   │       └── events/route.ts → GET events (SSE stream)
  │   ├── policy/
  │   │   ├── route.ts           → GET (list), POST (create)
  │   │   └── [id]/route.ts      → PATCH (update), DELETE
  │   └── webhooks/
  │       └── clerk/route.ts     → Clerk webhook handler
  │
  └── middleware.ts              → Clerk auth middleware
```

---

## 2. Pages — Detailed Specifications

### Page 1: Project Dashboard (`/dashboard/[projectSlug]`)

The main project overview. Shows:
- **Health indicators**: staleness status (how many days since last run), coverage percentage (% of codebase touched by tracked runs)
- **Recent runs**: last 5 runs with status badges (active/completed/aborted/error) and durations
- **Pack health**: list of active Feature Packs with version indicators
- **Quick actions**: "New Run", "View Context Archive", "Edit Policy Rules"

**Server Component** — data is fetched in the component body using Drizzle directly (not via API route). The page suspends during data loading with a `<Suspense>` boundary.

### Page 2: Feature Pack Editor (`/dashboard/[projectSlug]/packs/[packId]`)

A rich editor for Feature Pack content:
- **Pack hierarchy visualizer**: renders the parent chain as a breadcrumb tree showing which values are inherited vs. overridden
- **Content editor**: structured form fields for each content section (description, tools, allowedPaths, blockedPaths, conventions, dependencies, customInstructions)
- **Version history**: dropdown to switch between versions; diff view comparing versions
- **Save as new version**: creates a new version record, doesn't mutate the old one
- **Inheritance graph**: D3-based visualization of the pack inheritance tree for the project

**Client Component** — form state management, real-time preview, unsaved changes warning.

### Page 3: Context Pack Archive (`/dashboard/[projectSlug]/context`)

The searchable archive of all Context Packs:
- **Semantic search bar**: type natural language query → calls `/api/context?q=...` → NL Assembly service → ranked results
- **Filters**: by feature pack, by date range, by run status
- **Pack list**: cards showing title, run date, file count, semantic similarity score (when searching)
- **Diff viewer**: click any pack → shows the Context Pack content + semantic diff side by side

**Hybrid** — initial load is Server Component; search interaction is Client Component with `useSWR` for incremental results.

### Page 4: Run History Timeline (`/dashboard/[projectSlug]/runs`)

A chronological timeline of all runs:
- **Timeline visualization**: vertical timeline with run cards, showing start/end times and durations
- **Status indicators**: color-coded badges for active/completed/aborted/error
- **Real-time updates**: for active runs, shows a pulsing indicator and live event count updated via Server-Sent Events
- **Filter**: by status, by date range, by issue reference

**SSE for live runs**: When a run is `active`, the run list page opens an SSE connection to `/api/runs/[id]/events`. As new hook events arrive, the UI updates the event count and shows the latest tool name without full page reload.

### Page 5: Policy Configuration (`/dashboard/[projectSlug]/policy`)

Management interface for policy rules. The policy engine treats AI coding agents as **non-human identities (NHI)** — rules can be scoped per agent type.

- **Rules table**: shows all rules with priority order (drag-to-reorder), tool pattern, path pattern, **agent type** badge (`claude_code`, `cursor`, `copilot`, or `*` for all), decision badge
- **Edit in place**: click a rule → inline editor expands
- **Agent type selector**: dropdown with values `claude_code`, `cursor`, `copilot`, `*` (wildcard). Defaults to `*`.
- **Test rule**: input a tool name + file path + **agent type** → shows which rule would match and what decision it returns (calls policy engine in dry-run mode)
- **Priority drag-and-drop**: reorder rules by dragging; updates priority integers on save
- **New rule form**: modal with all fields including agent type; validation feedback inline
- **Audit log**: expandable section showing recent `policy_decisions` for the project — who (which agent) requested what, and what decision was made

**Client Component** — full interactivity required.

### Page 6: Project Settings (`/dashboard/[projectSlug]/settings`)

Project configuration:
- **Project details**: name, slug (readonly after creation), repo URL
- **Claude Code hook configuration**: shows the generated `.claude/settings.json` snippet with copy button
- **Cursor hook configuration**: shows the generated `.cursor/hooks.json` snippet and the `contextos.sh` adapter script with copy buttons. Includes a note explaining the stdin/stdout adapter pattern.
- **Token management**: generate/revoke Clerk M2M tokens for the project
- **Sync settings**: toggle cloud sync on/off, view last sync timestamp, force push/pull
- **Danger zone**: delete project (requires typing project name to confirm)

---

## 3. API Routes

All API routes are in `app/api/`. They use `auth()` from `@clerk/nextjs/server` to get the authenticated org ID.

### Pattern

```typescript
// app/api/projects/route.ts
import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { createDb } from '@contextos/db';
import { projects } from '@contextos/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  repoUrl: z.string().url().optional(),
});

export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createDb(process.env.DATABASE_URL!);
  const projectList = await db
    .select()
    .from(projects)
    .where(eq(projects.clerkOrgId, orgId))
    .orderBy(projects.createdAt, 'desc');

  return NextResponse.json({ projects: projectList });
}

export async function POST(request: Request) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const parsed = CreateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = createDb(process.env.DATABASE_URL!);
  const [project] = await db
    .insert(projects)
    .values({ ...parsed.data, clerkOrgId: orgId })
    .returning();

  return NextResponse.json({ project }, { status: 201 });
}
```

### SSE Route for Live Run Updates

```typescript
// app/api/runs/[id]/events/route.ts
import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const { orgId } = await auth();
  if (!orgId) return new Response('Unauthorized', { status: 401 });

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        if (!closed) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }
      };

      // Poll for new events every 2 seconds
      const interval = setInterval(async () => {
        if (closed) {
          clearInterval(interval);
          return;
        }
        const events = await getLatestEvents(params.id, orgId);
        send({ events, timestamp: new Date().toISOString() });
      }, 2000);

      // Clean up on disconnect
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

---

## 4. Auth Integration (Clerk Middleware)

`middleware.ts` at the root of `apps/web`:

```typescript
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
  '/api/webhooks/(.*)', // Clerk webhooks are verified by signature, not session
]);

export default clerkMiddleware((auth, request) => {
  if (!isPublicRoute(request)) {
    auth().protect();
  }
});

export const config = {
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)'],
};
```

In Server Components, `auth()` from `@clerk/nextjs/server` provides the current user and organization context without any additional middleware.

---

## 5. Real-Time Updates via Server-Sent Events

For active runs, the run timeline page displays a live event counter. Implementation:

- Run list page: Server Component that renders run cards
- Each active run card: Client Component that mounts an SSE connection
- SSE polls for new events every 2 seconds
- On run completion: SSE sends a `status: 'completed'` event; Client Component removes the live indicator

This is simpler than WebSockets for this use case (one-directional push from server to client) and requires no additional infrastructure (no Socket.io server, no Pusher, no Ably).

---

## 6. Sync API for VS Code Extension

The VS Code extension uses a local SQLite primary store. These endpoints enable bidirectional sync between the local store and cloud PostgreSQL.

### `POST /api/sync/push`

Receives locally-created records (runs, run events, context packs) from the VS Code extension and inserts them into cloud PostgreSQL. Uses `ON CONFLICT DO NOTHING` for idempotency.

```typescript
const PushPayloadSchema = z.object({
  runs: z.array(RunSchema).optional(),
  runEvents: z.array(RunEventSchema).optional(),
  contextPacks: z.array(ContextPackSchema).optional(),
});
```

Returns: `{ pushed: { runs: number, runEvents: number, contextPacks: number } }`

### `POST /api/sync/pull`

Returns records the extension doesn't have yet. The extension sends its latest `sync_state` cursor (timestamp of last pull), and the server returns all records newer than that cursor.

```typescript
const PullRequestSchema = z.object({
  since: z.string().datetime(),  // ISO 8601 timestamp of last pull
  projectId: z.string().uuid(),
});
```

Returns: `{ projects: [...], featurePacks: [...], runs: [...], syncCursor: "2026-01-20T12:00:00Z" }`
