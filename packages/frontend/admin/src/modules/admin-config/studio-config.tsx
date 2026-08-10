// ClickDz Work — Admin Studio Configuration page.
//
// Displays all studios from the STUDIOS registry with their group assignments
// and visibility flags. The admin can see which studios are visible, their
// group (create/commerce/agents/connect), and which are flag-gated. Studio
// visibility toggling and reordering are shown as a read-only view of the
// current configuration (changes require code changes to registry.ts + a
// redeploy, same as feature flags).

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@affine/admin/components/ui/card';
import { Badge } from '@affine/admin/components/ui/badge';
import { Separator } from '@affine/admin/components/ui/separator';
import {
  LayoutGridIcon,
  EyeIcon,
  EyeOffIcon,
  FlagIcon,
  GripVerticalIcon,
} from 'lucide-react';

import { Header } from '../header';

// ---------------------------------------------------------------------------
// Studio registry mirror — the admin panel cannot import from
// packages/frontend/core (cross-package), so we mirror the essential fields
// from STUDIOS here. Keep in lockstep with registry.ts.
// ---------------------------------------------------------------------------
interface StudioEntry {
  id: string;
  label: string;
  route: string;
  group: 'create' | 'commerce' | 'agents' | 'connect';
  flag?: string;
  beta?: boolean;
  isNew?: boolean;
}

const STUDIO_ENTRIES: StudioEntry[] = [
  { id: 'vdz', label: 'Vdz Studio', route: '/vdz', group: 'create', isNew: true },
  { id: 'apps', label: 'ClickDz Apps', route: '/apps', group: 'commerce' },
  { id: 'integrations', label: 'Integrations Flows', route: '/integrations', group: 'connect' },
  { id: 'shoperp', label: 'DzOS', route: '/shoperp', group: 'commerce' },
  { id: 'voice', label: 'Voice Studio', route: '/voice', group: 'create' },
  { id: 'hermes', label: 'Hermes', route: '/hermes', group: 'agents' },
  { id: 'openclaw', label: 'OpenClaw', route: '/openclaw', group: 'agents' },
  { id: 'agents', label: 'Agents', route: '/agents', group: 'agents', flag: 'agents-multi' },
  { id: 'vpic', label: 'Studio Image', route: '/vpic', group: 'create', flag: 'vpic' },
  { id: 'slidepro', label: 'SlidePro', route: '/slidepro', group: 'commerce', beta: true },
  { id: 'coursepro', label: 'CoursePro', route: '/coursepro', group: 'commerce' },
  { id: 'socialplus', label: 'Social', route: '/socialplus', group: 'commerce' },
  { id: 'zoomplus', label: 'ZOOM+', route: '/zoomplus', group: 'commerce', flag: 'zoomplus' },
  { id: 'whatsappmax', label: 'WhatsappMax', route: '/whatsappmax', group: 'connect', flag: 'whatsappmax' },
];

const GROUP_LABELS: { group: string; label: string }[] = [
  { group: 'create', label: 'Create' },
  { group: 'commerce', label: 'Commerce' },
  { group: 'agents', label: 'Agents' },
  { group: 'connect', label: 'Connect' },
];

const GROUP_COLORS: Record<string, string> = {
  create: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  commerce: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  agents: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200',
  connect: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
};

function StudioConfigContent() {
  // Group studios by their group, preserving order within groups
  const grouped = GROUP_LABELS.map(({ group, label }) => ({
    group,
    label,
    studios: STUDIO_ENTRIES.filter(s => s.group === group),
  }));

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      {/* Header card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <LayoutGridIcon size={20} />
            {`Configuration des studios`}
          </CardTitle>
          <CardDescription>
            {`${STUDIO_ENTRIES.length} studios organisés en ${GROUP_LABELS.length} groupes. Les studios avec un indicateur de flag sont conditionnels (visibles uniquement si le flag correspondant est activé).`}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Info banner */}
      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
        <FlagIcon size={18} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">{`Lecture seule`}</p>
          <p className="mt-1 text-blue-700 dark:text-blue-300">
            {`La configuration des studios (visibilité, groupes, ordre) est définie dans le code source (registry.ts). Modifier ces paramètres nécessite un changement de code + un redéploiement.`}
          </p>
        </div>
      </div>

      {/* Studio groups */}
      {grouped.map(({ group, label, studios }) => (
        <Card key={group}>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Badge className={GROUP_COLORS[group]} variant="secondary">
                {label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {`${studios.length} studio(s)`}
              </span>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex flex-col gap-0">
              {studios.map((studio, idx) => (
                <div key={studio.id}>
                  {idx > 0 && <Separator />}
                  <div className="flex items-center gap-3 py-2.5">
                    <GripVerticalIcon
                      size={16}
                      className="text-muted-foreground/40"
                    />
                    <div className="flex flex-1 items-center gap-2">
                      <span className="text-sm font-medium">{studio.label}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
                        {studio.route}
                      </code>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {studio.flag ? (
                        <Badge variant="outline" className="gap-1 text-xs">
                          <FlagIcon size={10} />
                          {studio.flag}
                        </Badge>
                      ) : null}
                      {studio.beta ? (
                        <Badge variant="secondary" className="text-xs">
                          {`Bêta`}
                        </Badge>
                      ) : null}
                      {studio.isNew ? (
                        <Badge variant="default" className="bg-blue-600 text-xs hover:bg-blue-600">
                          NEW
                        </Badge>
                      ) : null}
                      {studio.flag ? (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <EyeOffIcon size={12} />
                          {`Conditionnel`}
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                          <EyeIcon size={12} />
                          {`Visible`}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function StudioConfigPage() {
  return (
    <div className="flex h-dvh flex-1 flex-col bg-background">
      <Header title="Configuration des studios" />
      <StudioConfigContent />
    </div>
  );
}

export default StudioConfigPage;
