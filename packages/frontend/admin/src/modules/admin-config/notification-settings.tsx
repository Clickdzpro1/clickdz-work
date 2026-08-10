// ClickDz Work — Admin Notification Settings page (stubs).
//
// UI for configuring deploy notifications (email/Slack) and alert thresholds.
// The backend is a stub — these settings are not persisted yet. The page also
// shows the PostHog dashboard link for quick access.

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@affine/admin/components/ui/card';
import { Button } from '@affine/admin/components/ui/button';
import { Input } from '@affine/admin/components/ui/input';
import { Label } from '@affine/admin/components/ui/label';
import { Switch } from '@affine/admin/components/ui/switch';
import { Separator } from '@affine/admin/components/ui/separator';
import { Badge } from '@affine/admin/components/ui/badge';
import {
  BellIcon,
  ExternalLinkIcon,
  MailIcon,
  MessageSquareIcon,
  AlertTriangleIcon,
} from 'lucide-react';
import { useState } from 'react';

import { Header } from '../header';

function NotificationSettingsContent() {
  // Local state only — persistence requires a backend resolver (stub).
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailAddress, setEmailAddress] = useState('');
  const [slackEnabled, setSlackEnabled] = useState(false);
  const [slackWebhook, setSlackWebhook] = useState('');
  const [buildFailThreshold, setBuildFailThreshold] = useState('3');
  const [deployNotify, setDeployNotify] = useState(true);

  const posthogHost = 'https://us.i.posthog.com';
  const posthogDashboardUrl = `${posthogHost}/dashboard`;

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      {/* Deploy notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <BellIcon size={20} />
            {`Notifications de déploiement`}
          </CardTitle>
          <CardDescription>
            {`Configurez les canaux de notification pour les événements de déploiement (CI/CD, Railway).`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Email */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                <MailIcon size={16} className="text-muted-foreground" />
              </div>
              <div className="flex flex-col">
                <Label className="text-sm font-medium">{`Notification par email`}</Label>
                <span className="text-xs text-muted-foreground">
                  {`Recevoir un email lors de chaque déploiement`}
                </span>
              </div>
            </div>
            <Switch
              checked={emailEnabled}
              onCheckedChange={setEmailEnabled}
              aria-label="Notification par email"
            />
          </div>
          {emailEnabled && (
            <div className="flex flex-col gap-1.5 pl-11">
              <Label htmlFor="email-address" className="text-xs">
                {`Adresse email`}
              </Label>
              <Input
                id="email-address"
                type="email"
                value={emailAddress}
                onChange={e => setEmailAddress(e.target.value)}
                placeholder="admin@clickdz.ai"
                className="h-8 text-sm"
              />
            </div>
          )}

          <Separator />

          {/* Slack */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                <MessageSquareIcon size={16} className="text-muted-foreground" />
              </div>
              <div className="flex flex-col">
                <Label className="text-sm font-medium">{`Notification Slack`}</Label>
                <span className="text-xs text-muted-foreground">
                  {`Envoyer un message Slack lors de chaque déploiement`}
                </span>
              </div>
            </div>
            <Switch
              checked={slackEnabled}
              onCheckedChange={setSlackEnabled}
              aria-label="Notification Slack"
            />
          </div>
          {slackEnabled && (
            <div className="flex flex-col gap-1.5 pl-11">
              <Label htmlFor="slack-webhook" className="text-xs">
                {`URL du webhook Slack`}
              </Label>
              <Input
                id="slack-webhook"
                type="url"
                value={slackWebhook}
                onChange={e => setSlackWebhook(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="h-8 text-sm"
              />
            </div>
          )}

          <Separator />

          {/* Deploy notify toggle */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <Label className="text-sm font-medium">
                {`Notifier à chaque déploiement`}
              </Label>
              <span className="text-xs text-muted-foreground">
                {`Activer les notifications pour tous les déploiements Railway`}
              </span>
            </div>
            <Switch
              checked={deployNotify}
              onCheckedChange={setDeployNotify}
              aria-label="Notifier à chaque déploiement"
            />
          </div>
        </CardContent>
      </Card>

      {/* Alert thresholds */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertTriangleIcon size={20} />
            {`Seuils d’alerte`}
          </CardTitle>
          <CardDescription>
            {`Configurez les conditions qui déclenchent une alerte.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="build-fail-threshold" className="text-xs">
              {`Échecs de build consécutifs avant alerte`}
            </Label>
            <Input
              id="build-fail-threshold"
              type="number"
              min="1"
              max="10"
              value={buildFailThreshold}
              onChange={e => setBuildFailThreshold(e.target.value)}
              className="h-8 w-24 text-sm"
            />
            <span className="text-xs text-muted-foreground">
              {`Une alerte est déclenchée après ce nombre d’échecs de build consécutifs.`}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* PostHog dashboard */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            {`Tableau de bord PostHog`}
          </CardTitle>
          <CardDescription>
            {`Accédez au tableau de bord analytique PostHog pour consulter les métriques d’utilisation.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Badge variant="outline">{`Zone: US`}</Badge>
              <code className="text-xs text-muted-foreground">{posthogHost}</code>
            </div>
            <a
              href={posthogDashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" size="sm" className="gap-1.5">
                {`Ouvrir PostHog`}
                <ExternalLinkIcon size={14} />
              </Button>
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Save stub */}
      <div className="flex items-center gap-3">
        <Button
          onClick={() => {
            // STUB: persistence requires a backend resolver.
          }}
        >
          {`Enregistrer`}
        </Button>
        <span className="text-xs text-muted-foreground">
          {`La persistance de ces paramètres nécessite un résolveur backend (à venir).`}
        </span>
      </div>
    </div>
  );
}

export function NotificationSettingsPage() {
  return (
    <div className="flex h-dvh flex-1 flex-col bg-background">
      <Header title="Notifications" />
      <NotificationSettingsContent />
    </div>
  );
}

export default NotificationSettingsPage;
