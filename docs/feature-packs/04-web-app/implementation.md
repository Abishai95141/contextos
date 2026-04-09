# Feature Pack 04: Web Application — Implementation Guide

## Prerequisites

Module 01 (Foundation) complete. Module 02 (MCP Server) running. Module 03 (Hooks Bridge) running.

---

## Step 1: Initialize Next.js 15

```bash
# From repo root
pnpm create next-app@latest apps/web \
  --typescript \
  --tailwind \
  --eslint=false \
  --app \
  --src-dir=false \
  --import-alias='@/*'

cd apps/web

# Install Clerk
pnpm add @clerk/nextjs

# Install database and shared packages
pnpm add @contextos/db@workspace:* @contextos/shared@workspace:*

# Install SWR for client-side data fetching
pnpm add swr

# Install UI utilities
pnpm add clsx tailwind-merge
```

Update `apps/web/package.json` to match monorepo conventions:

```json
{
  "name": "@contextos/web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "next build",
    "dev": "next dev --port 3002",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "biome check app/ components/ lib/"
  }
}
```

---

## Step 2: Configure Clerk Provider

Create `apps/web/app/layout.tsx`:

```typescript
import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'ContextOS',
  description: 'AI Agent Context Management Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang='en'>
        <body className={inter.className}>{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

Create `apps/web/middleware.ts`:

```typescript
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
  '/api/webhooks/(.*)',
]);

export default clerkMiddleware((auth, request) => {
  if (!isPublicRoute(request)) {
    auth().protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
```

Create auth pages:

```bash
mkdir -p apps/web/app/\(auth\)/sign-in/\[\[...sign-in\]\]
mkdir -p apps/web/app/\(auth\)/sign-up/\[\[...sign-up\]\]
```

`apps/web/app/(auth)/sign-in/[[...sign-in]]/page.tsx`:

```typescript
import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className='flex min-h-screen items-center justify-center bg-gray-50'>
      <SignIn />
    </div>
  );
}
```

`apps/web/app/(auth)/sign-up/[[...sign-up]]/page.tsx`:

```typescript
import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <div className='flex min-h-screen items-center justify-center bg-gray-50'>
      <SignUp />
    </div>
  );
}
```

---

## Step 3: Create the Database Helper for Server Components

Create `apps/web/lib/db.ts`:

```typescript
import { createDb } from '@contextos/db';

// Singleton for server-side DB access in Next.js
let db: ReturnType<typeof createDb> | null = null;

export function getDb(): ReturnType<typeof createDb> {
  if (!db) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    db = createDb(process.env.DATABASE_URL);
  }
  return db;
}
```

Create `apps/web/lib/auth.ts`:

```typescript
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export async function requireOrgId(): Promise<string> {
  const { orgId } = await auth();
  if (!orgId) {
    redirect('/sign-in');
  }
  return orgId;
}
```

---

## Step 4: Project Dashboard Page

Create `apps/web/app/dashboard/page.tsx`:

```typescript
import { Suspense } from 'react';
import Link from 'next/link';
import { requireOrgId } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { projects, runs } from '@contextos/db/schema';
import { eq, desc, count } from 'drizzle-orm';
import { ProjectCard } from '@/components/project-card';
import { CreateProjectButton } from '@/components/create-project-button';

export default async function DashboardPage() {
  const orgId = await requireOrgId();
  const db = getDb();

  const projectList = await db
    .select({
      project: projects,
      runCount: count(runs.id),
    })
    .from(projects)
    .leftJoin(runs, eq(runs.projectId, projects.id))
    .where(eq(projects.clerkOrgId, orgId))
    .groupBy(projects.id)
    .orderBy(desc(projects.createdAt));

  return (
    <main className='mx-auto max-w-7xl px-4 py-8'>
      <div className='mb-8 flex items-center justify-between'>
        <div>
          <h1 className='text-2xl font-bold text-gray-900'>Projects</h1>
          <p className='mt-1 text-sm text-gray-500'>
            Manage AI agent context for your projects
          </p>
        </div>
        <CreateProjectButton />
      </div>

      {projectList.length === 0 ? (
        <div className='rounded-lg border-2 border-dashed border-gray-300 p-12 text-center'>
          <p className='text-gray-500'>No projects yet. Create your first project to get started.</p>
          <CreateProjectButton className='mt-4' />
        </div>
      ) : (
        <div className='grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3'>
          {projectList.map(({ project, runCount }) => (
            <Suspense key={project.id} fallback={<ProjectCardSkeleton />}>
              <ProjectCard project={project} runCount={runCount} />
            </Suspense>
          ))}
        </div>
      )}
    </main>
  );
}

function ProjectCardSkeleton() {
  return (
    <div className='h-48 animate-pulse rounded-lg bg-gray-200' />
  );
}
```

---

## Step 5: Feature Pack Editor

Create `apps/web/app/dashboard/[projectSlug]/packs/[packId]/page.tsx`:

```typescript
import { notFound } from 'next/navigation';
import { requireOrgId } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { featurePacks, projects } from '@contextos/db/schema';
import { eq, and } from 'drizzle-orm';
import { PackEditor } from '@/components/pack-editor';
import { InheritanceGraph } from '@/components/inheritance-graph';

interface Props {
  params: { projectSlug: string; packId: string };
}

export default async function PackEditorPage({ params }: Props) {
  const orgId = await requireOrgId();
  const db = getDb();

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.slug, params.projectSlug), eq(projects.clerkOrgId, orgId)))
    .limit(1);

  if (!project) notFound();

  const [pack] = await db
    .select()
    .from(featurePacks)
    .where(and(eq(featurePacks.id, params.packId), eq(featurePacks.projectId, project.id)))
    .limit(1);

  if (!pack) notFound();

  // Load full pack hierarchy for inheritance graph
  const allPacks = await db
    .select({ id: featurePacks.id, name: featurePacks.name, parentId: featurePacks.parentId, slug: featurePacks.slug })
    .from(featurePacks)
    .where(eq(featurePacks.projectId, project.id));

  return (
    <div className='mx-auto max-w-7xl px-4 py-8'>
      <div className='mb-6'>
        <h1 className='text-2xl font-bold text-gray-900'>{pack.name}</h1>
        <p className='text-sm text-gray-500'>
          v{pack.version} · {pack.isActive ? 'Active' : 'Inactive'}
        </p>
      </div>

      <div className='grid grid-cols-1 gap-8 lg:grid-cols-3'>
        <div className='lg:col-span-2'>
          <PackEditor
            pack={pack}
            projectSlug={params.projectSlug}
          />
        </div>
        <div>
          <h2 className='mb-4 text-lg font-semibold'>Inheritance Graph</h2>
          <InheritanceGraph packs={allPacks} currentPackId={pack.id} />
        </div>
      </div>
    </div>
  );
}
```

Create `apps/web/components/pack-editor.tsx` (Client Component):

```typescript
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FeaturePack } from '@contextos/shared';
import { FeaturePackContentSchema } from '@contextos/shared';

interface PackEditorProps {
  pack: FeaturePack;
  projectSlug: string;
}

export function PackEditor({ pack, projectSlug }: PackEditorProps) {
  const router = useRouter();
  const [content, setContent] = useState(() =>
    FeaturePackContentSchema.parse(pack.content),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Warn before navigating away with unsaved changes
  // (useBeforeUnload hook)

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/packs/${pack.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Failed to save');
        return;
      }
      setIsDirty(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAsNewVersion = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/packs/${pack.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Failed to create version');
        return;
      }
      const { packId } = await res.json();
      router.push(`/dashboard/${projectSlug}/packs/${packId}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='space-y-6 rounded-lg border border-gray-200 p-6'>
      {error && (
        <div className='rounded-md bg-red-50 p-3 text-sm text-red-800'>{error}</div>
      )}

      {/* Description field */}
      <div>
        <label className='block text-sm font-medium text-gray-700'>Description</label>
        <textarea
          className='mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500'
          rows={3}
          value={content.description}
          onChange={(e) => {
            setContent((prev) => ({ ...prev, description: e.target.value }));
            setIsDirty(true);
          }}
        />
      </div>

      {/* Allowed paths field */}
      <div>
        <label className='block text-sm font-medium text-gray-700'>
          Allowed Paths (one glob per line)
        </label>
        <textarea
          className='mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-teal-500 focus:outline-none'
          rows={4}
          value={content.allowedPaths.join('\n')}
          onChange={(e) => {
            setContent((prev) => ({
              ...prev,
              allowedPaths: e.target.value.split('\n').filter(Boolean),
            }));
            setIsDirty(true);
          }}
        />
      </div>

      {/* Custom instructions */}
      <div>
        <label className='block text-sm font-medium text-gray-700'>Custom Instructions</label>
        <textarea
          className='mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none'
          rows={6}
          value={content.customInstructions ?? ''}
          onChange={(e) => {
            setContent((prev) => ({ ...prev, customInstructions: e.target.value || undefined }));
            setIsDirty(true);
          }}
          placeholder='Additional instructions for the AI agent when working on this pack...'
        />
      </div>

      {/* Action buttons */}
      <div className='flex gap-3'>
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className='rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50'
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleSaveAsNewVersion}
          disabled={saving}
          className='rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50'
        >
          Save as New Version
        </button>
      </div>
    </div>
  );
}
```

---

## Step 6: Context Pack Archive with Semantic Search

Create `apps/web/app/dashboard/[projectSlug]/context/page.tsx`:

```typescript
import { requireOrgId } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { projects } from '@contextos/db/schema';
import { and, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { ContextArchive } from '@/components/context-archive';

interface Props {
  params: { projectSlug: string };
  searchParams: { q?: string };
}

export default async function ContextPage({ params, searchParams }: Props) {
  const orgId = await requireOrgId();
  const db = getDb();

  const [project] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.slug, params.projectSlug), eq(projects.clerkOrgId, orgId)))
    .limit(1);

  if (!project) notFound();

  return (
    <main className='mx-auto max-w-7xl px-4 py-8'>
      <h1 className='mb-6 text-2xl font-bold text-gray-900'>Context Pack Archive</h1>
      <ContextArchive
        projectId={project.id}
        projectSlug={params.projectSlug}
        initialQuery={searchParams.q}
      />
    </main>
  );
}
```

Create `apps/web/components/context-archive.tsx` (Client Component):

```typescript
'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useRouter, usePathname } from 'next/navigation';

interface ContextArchiveProps {
  projectId: string;
  projectSlug: string;
  initialQuery?: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function ContextArchive({ projectId, projectSlug, initialQuery }: ContextArchiveProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery ?? '');

  const apiUrl = debouncedQuery
    ? `/api/context?projectId=${projectId}&q=${encodeURIComponent(debouncedQuery)}`
    : `/api/context?projectId=${projectId}`;

  const { data, isLoading, error } = useSWR(apiUrl, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    // Debounce: wait 400ms before triggering search
    const timer = setTimeout(() => {
      setDebouncedQuery(value);
      const params = new URLSearchParams();
      if (value) params.set('q', value);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }, 400);
    return () => clearTimeout(timer);
  }, [router, pathname]);

  return (
    <div>
      {/* Search bar */}
      <div className='mb-6'>
        <input
          type='text'
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder='Search context packs in natural language...'
          className='w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500'
        />
        {debouncedQuery && (
          <p className='mt-2 text-xs text-gray-500'>
            Semantic search — finding packs related to "{debouncedQuery}"
          </p>
        )}
      </div>

      {/* Results */}
      {isLoading && (
        <div className='space-y-4'>
          {[1, 2, 3].map((i) => (
            <div key={i} className='h-24 animate-pulse rounded-lg bg-gray-100' />
          ))}
        </div>
      )}

      {error && (
        <div className='rounded-md bg-red-50 p-4 text-sm text-red-800'>
          Failed to load context packs. Please try again.
        </div>
      )}

      {data?.packs?.length === 0 && (
        <p className='text-center text-gray-500'>
          {debouncedQuery ? 'No context packs match your search.' : 'No context packs yet.'}
        </p>
      )}

      {data?.packs && (
        <div className='space-y-4'>
          {data.packs.map((pack: { id: string; title: string; content: string; similarity?: number; createdAt: string }) => (
            <a
              key={pack.id}
              href={`/dashboard/${projectSlug}/context/${pack.id}`}
              className='block rounded-lg border border-gray-200 p-4 hover:border-teal-400 hover:shadow-sm transition-all'
            >
              <div className='flex items-start justify-between'>
                <h3 className='font-medium text-gray-900'>{pack.title}</h3>
                {pack.similarity !== undefined && (
                  <span className='ml-4 shrink-0 rounded-full bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800'>
                    {Math.round(pack.similarity * 100)}% match
                  </span>
                )}
              </div>
              <p className='mt-1 text-sm text-gray-500 line-clamp-2'>
                {pack.content.slice(0, 200)}...
              </p>
              <p className='mt-2 text-xs text-gray-400'>
                {new Date(pack.createdAt).toLocaleDateString()}
              </p>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Step 7: Clerk Webhook Handler

Create `apps/web/app/api/webhooks/clerk/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { Webhook } from 'svix';
import { getDb } from '@/lib/db';
import { projects } from '@contextos/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  const svix_id = request.headers.get('svix-id');
  const svix_timestamp = request.headers.get('svix-timestamp');
  const svix_signature = request.headers.get('svix-signature');

  if (!svix_id || !svix_timestamp || !svix_signature) {
    return NextResponse.json({ error: 'Missing svix headers' }, { status: 400 });
  }

  const body = await request.text();
  const wh = new Webhook(webhookSecret);

  let event: { type: string; data: Record<string, unknown> };
  try {
    event = wh.verify(body, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as typeof event;
  } catch {
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 400 });
  }

  const db = getDb();

  // Handle organization deletion: remove all projects for that org
  if (event.type === 'organization.deleted') {
    const orgId = event.data.id as string;
    await db.delete(projects).where(eq(projects.clerkOrgId, orgId));
  }

  return NextResponse.json({ received: true });
}
```

---

## Step 8: Run History with SSE

Create `apps/web/app/dashboard/[projectSlug]/runs/page.tsx`:

```typescript
import { requireOrgId } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { projects, runs, runEvents } from '@contextos/db/schema';
import { and, eq, desc, count } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { RunTimeline } from '@/components/run-timeline';

interface Props {
  params: { projectSlug: string };
}

export default async function RunsPage({ params }: Props) {
  const orgId = await requireOrgId();
  const db = getDb();

  const [project] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.slug, params.projectSlug), eq(projects.clerkOrgId, orgId)))
    .limit(1);

  if (!project) notFound();

  const runList = await db
    .select({
      run: runs,
      eventCount: count(runEvents.id),
    })
    .from(runs)
    .leftJoin(runEvents, eq(runEvents.runId, runs.id))
    .where(eq(runs.projectId, project.id))
    .groupBy(runs.id)
    .orderBy(desc(runs.startedAt))
    .limit(50);

  return (
    <main className='mx-auto max-w-4xl px-4 py-8'>
      <h1 className='mb-8 text-2xl font-bold text-gray-900'>Run History</h1>
      <RunTimeline runs={runList} />
    </main>
  );
}
```

---

## Verification Checklist

- [ ] `pnpm turbo run build --filter=@contextos/web` succeeds
- [ ] `pnpm turbo run typecheck --filter=@contextos/web` passes
- [ ] `GET /api/health` returns `200`
- [ ] Sign-in page renders at `/sign-in`
- [ ] Unauthenticated request to `/dashboard` redirects to `/sign-in`
- [ ] After sign-in, `/dashboard` shows project list (empty or with data)
- [ ] Creating a project via the UI inserts a record in the DB
- [ ] Feature Pack editor loads and saves content
- [ ] Context Pack archive semantic search returns results (requires NL Assembly running)
- [ ] Run history timeline shows runs ordered by start time
- [ ] Live run SSE endpoint returns SSE-formatted events
- [ ] Clerk webhook endpoint returns 400 for requests without svix headers
