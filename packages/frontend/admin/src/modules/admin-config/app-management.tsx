// ClickDz Work — Admin App Management page.
//
// Shows all 16 ClickDz apps with their current status, display names +
// descriptions (editable in local state — persistence requires a backend
// resolver, which is a future enhancement), and user grant counts (how many
// users have each app granted via the adminUserAppEntitlements query).
//
// The "global toggle" here is a visual indicator of whether the app is
// globally available (any user has it granted) vs disabled (no users have it).
// Toggling globally would require revoking/granting for ALL users, which is
// a batch operation — the UI shows the current state and provides a note.

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@affine/admin/components/ui/card';
import { Badge } from '@affine/admin/components/ui/badge';
import { Button } from '@affine/admin/components/ui/button';
import { Input } from '@affine/admin/components/ui/input';
import { Label } from '@affine/admin/components/ui/label';
import { Textarea } from '@affine/admin/components/ui/textarea';
import { Skeleton } from '@affine/admin/components/ui/skeleton';
import { useQuery } from '@affine/admin/use-query';
import type { GraphQLQuery } from '@affine/graphql';
import {
  AppWindowIcon,
  FolderCogIcon,
  InfoIcon,
  UsersIcon,
} from 'lucide-react';
import { Suspense, useMemo, useState } from 'react';

import { Header } from '../header';
import { USER_APPS, type UserAppKey } from '../accounts/app-entitlements';

// ---------------------------------------------------------------------------
// Admin entitlements query (reuses the same query as analytics — grouped by
// user, so we aggregate client-side to get per-app user counts).
// ---------------------------------------------------------------------------
interface AdminUserAppEntitlement {
  userId: string;
  entitlements: { app: string; active: boolean }[];
}

interface AdminAppEntitlementsResponse {
  adminUserAppEntitlements: AdminUserAppEntitlement[];
}

const adminAppEntitlementsQuery = {
  id: 'adminAppManagementEntitlementsQuery' as const,
  op: 'adminUserAppEntitlements',
  query: `query adminAppManagementEntitlements {
  adminUserAppEntitlements {
    userId
    entitlements {
      app
      active
    }
  }
}`,
} satisfies GraphQLQuery;

// ---------------------------------------------------------------------------
// App metadata — display names + descriptions (editable in local state).
// The initial values match the labels from USER_APPS. When the admin edits
// them, the change is stored in local React state only — persisting requires
// a backend resolver (future enhancement). The UI is ready for that wiring.
// ---------------------------------------------------------------------------
interface AppMeta {
  key: UserAppKey;
  label: string;
  description: string;
}

const INITIAL_APP_DESCRIPTIONS: Record<UserAppKey, string> = {
  SLIDE_PRO: `Créateur de présentations slide-by-slide`,
  SOCIAL_PLUS: `Studio de publication sociale multi-plateformes`,
  COURSE_PRO: `Générateur de cours en ligne`,
  ZOOM_PLUS: `Visioconférence intégrée via Meet`,
  VDZ: `Studio de création vidéo Vdz`,
  VOICE: `Studio de génération vocale (TTS)`,
  APPS: `Constructeur d’applications ClickDz`,
  SHOPERP: `ERP et gestion de boutique (DzOS)`,
  HERMES: `Agent IA de messagerie`,
  OPENCLAW: `Agent IA de code et terminal`,
  AGENTS: `Agents IA personnalisés`,
  VPIC: `Éditeur d’images IA`,
  INTEGRATIONS: `Flux d’intégrations automatisés`,
  WHATSAPPMAX: `WhatsApp multi-comptes`,
  AI_CHAT: `Chat IA généraliste`,
  WHITEBOARD: `Tableau blanc collaboratif`,
};

function AppManagementContent() {
  const { data } = useQuery({
    query: adminAppEntitlementsQuery,
  } as Parameters<typeof useQuery>[0]);

  const entitlementsData =
    (data as unknown as AdminAppEntitlementsResponse | undefined)
      ?.adminUserAppEntitlements ?? [];

  // Aggregate: for each app, count how many users have it granted (active)
  const appUserCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const userEnt of entitlementsData) {
      for (const ent of userEnt.entitlements) {
        if (ent.active) {
          counts.set(ent.app, (counts.get(ent.app) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [entitlementsData]);

  // Local state for editable display names + descriptions
  const [appMetas, setAppMetas] = useState<Record<UserAppKey, AppMeta>>(() => {
    const map = {} as Record<UserAppKey, AppMeta>;
    for (const app of USER_APPS) {
      map[app.key] = {
        key: app.key,
        label: app.label,
        description: INITIAL_APP_DESCRIPTIONS[app.key] ?? '',
      };
    }
    return map;
  });

  const [dirty, setDirty] = useState(false);

  const updateMeta = (key: UserAppKey, field: 'label' | 'description', value: string) => {
    setAppMetas(prev => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
    setDirty(true);
  };

  const handleSave = () => {
    // STUB: persistence requires a backend resolver (e.g., updateAppMeta
    // mutation that stores display names + descriptions in a config table).
    // For now, the save is local-state-only.
    setDirty(false);
  };

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      {/* Header card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <AppWindowIcon size={20} />
            {`Gestion des applications`}
          </CardTitle>
          <CardDescription>
            {`${USER_APPS.length} applications ClickDz. Modifiez les noms d’affichage et les descriptions, et consultez le nombre d’utilisateurs ayant accès.`}
          </CardDescription>
        </CardHeader>
        {dirty && (
          <CardContent className="pt-0">
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={handleSave}>
                {`Enregistrer les modifications`}
              </Button>
              <span className="text-xs text-muted-foreground">
                {`Les modifications sont locales pour le moment (la persistance nécessite un résolveur backend).`}
              </span>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Info banner */}
      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <InfoIcon size={18} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">{`Modification des noms et descriptions`}</p>
          <p className="mt-1 text-amber-700 dark:text-amber-300">
            {`Les noms d’affichage et descriptions sont éditables ci-dessous. La persistance de ces modifications nécessite l’ajout d’un résolveur backend (à venir).`}
          </p>
        </div>
      </div>

      {/* Apps list */}
      <div className="flex flex-col gap-3">
        {USER_APPS.map((app) => {
          const meta = appMetas[app.key];
          const userCount = appUserCounts.get(app.key.toLowerCase()) ?? 0;
          const isGloballyEnabled = userCount > 0;

          return (
            <Card key={app.key}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-muted px-2 py-0.5 text-sm font-mono">
                      {app.key}
                    </code>
                    {isGloballyEnabled ? (
                      <Badge variant="default" className="bg-green-600 hover:bg-green-600">
                        {`Actif`}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">{`Inactif`}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <UsersIcon size={14} />
                    <span className="tabular-nums">{userCount}</span>
                    <span>{`utilisateur(s)`}</span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 pt-0">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`label-${app.key}`} className="text-xs">
                      {`Nom d’affichage`}
                    </Label>
                    <Input
                      id={`label-${app.key}`}
                      value={meta.label}
                      onChange={e => updateMeta(app.key, 'label', e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`desc-${app.key}`} className="text-xs">
                      {`Description`}
                    </Label>
                    <Textarea
                      id={`desc-${app.key}`}
                      value={meta.description}
                      onChange={e => updateMeta(app.key, 'description', e.target.value)}
                      className="min-h-[36px] text-sm"
                      rows={2}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function AppManagementSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  );
}

export function AppManagementPage() {
  return (
    <div className="flex h-dvh flex-1 flex-col bg-background">
      <Header title="Gestion des applications" />
      <Suspense fallback={<AppManagementSkeleton />}>
        <AppManagementContent />
      </Suspense>
    </div>
  );
}

export default AppManagementPage;
