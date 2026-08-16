// Social — native AI social media studio for ClickDz Work.
// E2: full Social studio UI — view-switcher shell + co-located social/ folder.
// Connections dashboard · Composer · Calendar · Queue · Published Log.
// Postiz-inspired UX; only features the E1 backend supports.
// FR/AR/RTL throughout (mirrors admin-stock.tsx i18n pattern).

import { useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, miniBtnStyle, Banner } from './shoperp-shared';
import { fetchAccounts, fetchConfig, type SocialConfig, type SocialPost } from './social/api';
import { ConnectionsView } from './social/connections';
import { ComposerView } from './social/composer';
import { CalendarView } from './social/calendar';
import { QueueView } from './social/queue';
import { LogView } from './social/log';
import { SettingsView } from './social/settings';

// ---------------------------------------------------------------------------
// i18n dictionary — FR / AR / EN
// Three-key object; each view pulls from this via its `dict` prop so all
// surface-level strings are centralised here, mirroring admin-stock.tsx.
// ---------------------------------------------------------------------------

type Lang = 'fr' | 'ar' | 'en';

const DICT: Record<Lang, Record<string, string>> = {
  fr: {
    title: 'Social',
    subtitle: 'Studio réseaux sociaux IA · CDZ Connect · cdz-flash',
    refresh: '↻ Actualiser',
    loading: 'Chargement…',
    notConfiguredBanner: "CDZ Connect n'est pas encore configuré (COMPOSIO_API_KEY manquant côté serveur).",
    notConfigured: "CDZ Connect n'est pas encore configuré.",
    connectNetworks: 'Connectez vos réseaux',
    connect: 'Connecter',
    connecting: 'Connexion…',
    disconnect: 'Déconnecter',
    disconnecting: 'Déconnexion…',
    connected: 'Connecté',
    disconnectedBadge: 'Non connecté',
    disconnected: 'Déconnecté.',
    disconnectFail: 'La déconnexion a échoué. Réessayez.',
    connectOpened: "Autorisation ouverte dans un nouvel onglet — terminez la connexion, puis revenez et cliquez Actualiser.",
    authUnconfigured: "n'est pas encore disponible via CDZ Connect.",
    connectFail: "Connexion impossible pour le moment.",
    mediaRequired: 'Média requis',
    view_connections: 'Connexions',
    view_composer: 'Composer',
    view_calendar: 'Calendrier',
    view_queue: 'File d\'attente',
    view_log: 'Journal',
    view_settings: 'Réglages',
    noNetworks: "Connectez au moins un réseau dans l'onglet Connexions pour composer et publier.",
    // UP1 — Réglages avancés
    settingsIntro: "Ces réglages s'appliquent automatiquement lors de la publication : hashtags par défaut, paramètres UTM sur les liens, premier commentaire, et règles de file d'attente.",
    settingsSaved: 'Réglages enregistrés.',
    settingsFail: "L'enregistrement a échoué. Réessayez.",
    saveSettings: 'Enregistrer les réglages',
    saving: 'Enregistrement…',
    reset: 'Réinitialiser',
    timezone: 'Fuseau horaire',
    timezoneDesc: 'Utilisé pour les fenêtres de publication.',
    networkDefaults: 'Réglages par réseau',
    networkDefaultsDesc: 'Hashtags, premier commentaire et créneaux préférés par réseau.',
    defaultHashtags: 'Hashtags par défaut',
    addHashtag: 'Ajouter des hashtags (Entrée)',
    noHashtags: 'Aucun',
    firstComment: 'Premier commentaire',
    firstCommentHint: 'Publié en commentaire juste après la publication (ex : lien en bio, hashtags additionnels)…',
    charLimitLabel: 'Limite du réseau',
    postingWindows: 'Créneaux de publication préférés',
    suggestionLabel: 'Suggestions :',
    suggestionHint: 'Suggestion (heuristique, pas des statistiques de votre compte)',
    windowsShort: 'créneaux',
    hasFirstComment: '1er comm.',
    utmTitle: 'Paramètres UTM (liens)',
    utmDesc: 'Ajoutés automatiquement au premier lien de chaque publication.',
    utmEnable: 'Activer le marquage UTM',
    utmMediumHint: '(réseau)',
    queueRules: "Règles de file d'attente",
    queueRulesDesc: 'Cadence, espacement et validation des publications.',
    maxPerDay: 'Max publications / jour / réseau',
    unlimited: 'illimité',
    minGap: 'Écart minimum (minutes)',
    autoRequeue: 'Re-programmer automatiquement en cas d\'échec (backoff exponentiel)',
    autoRequeueMax: 'Nombre max de tentatives auto',
    approvalRequired: 'Validation requise (brouillon → en attente → programmé)',
    // UP1 — composer / queue / log additions
    firstCommentField: 'Premier commentaire (optionnel)',
    firstCommentFieldHint: 'Publié en commentaire après la publication principale.',
    bestTime: 'Meilleur moment :',
    bestTimeHint: 'Suggestion — remplit la date de programmation.',
    submitApproval: 'Soumettre pour validation',
    approve: 'Approuver',
    approving: 'Approbation…',
    approved: 'Approuvé.',
    approveFail: "L'approbation a échoué.",
    pendingApproval: 'En attente de validation',
    variantTabMaster: 'Texte principal',
    queueRuleBlocked: 'Bloqué par une règle de file d\'attente :',
    connStatusActive: 'Actif',
    connStatusPending: 'En attente…',
    connStatusExpired: 'Expiré',
    connStatusFailed: 'Échec',
    errorDetail: 'Détail de l\'erreur',
    attempts: 'tentatives',
    action: 'Action',
    tab_compose: 'Écrire',
    tab_ai: 'IA',
    tab_media: 'Média',
    tab_preview: 'Aperçu',
    publishTo: 'Publier sur :',
    baseCaption: 'Texte de base',
    captionPlaceholder: 'Rédigez votre publication…',
    perNetworkOverrides: 'Textes par réseau (optionnel)',
    overridePlaceholder: 'Texte personnalisé pour ce réseau (laissez vide pour utiliser le texte de base)',
    scheduleAt: 'Programmer pour :',
    scheduleFuture: 'La date doit être dans le futur.',
    scheduled: 'Publication programmée.',
    draftSaved: 'Brouillon enregistré.',
    published: 'Publié !',
    submitFail: 'Échec. Réessayez.',
    saveDraft: 'Enregistrer le brouillon',
    schedule: 'Programmer',
    publishNow: 'Publier maintenant',
    cancel: 'Annuler',
    mediaRequiredWarning: 'Média requis pour :',
    mediaRequiredFor: 'Média requis pour',
    aiCompose: 'Génération IA de contenu',
    briefPlaceholder: 'Décrivez la publication (ex : « promo -20% sur les baskets ce week-end »)…',
    tone: 'Ton :',
    hashtags: 'Hashtags',
    emojiToggle: 'Emoji',
    perNetwork: 'Variantes par réseau',
    generateContent: '✨ Générer le contenu',
    generating: 'Génération…',
    aiNotConfigured: "La génération IA n'est pas encore configurée sur ce serveur.",
    genOk: "Brouillon généré — relisez et modifiez avant de publier.",
    genFail: "Génération impossible pour le moment — réessayez.",
    media: 'Média',
    uploadFile: 'Importer un fichier',
    or: 'ou',
    aiImageBelow: 'générer avec l\'IA ci-dessous',
    aiImage: 'Générer une image avec CDZIM IA',
    imgPromptPlaceholder: "Décrivez l'image à générer…",
    imgGenOk: 'Image générée et ajoutée.',
    imgGenFail: 'Génération d\'image impossible. Réessayez.',
    generate: 'Générer',
    emoji: 'Emoji :',
    preview: 'Aperçu',
    selectNetworksFirst: 'Sélectionnez des réseaux ci-dessus pour voir les aperçus.',
    status_all: 'Tous',
    status_draft: 'Brouillon',
    'status_pending-approval': 'À valider',
    status_scheduled: 'Programmé',
    status_publishing: 'En cours',
    status_published: 'Publié',
    status_partial: 'Partiel',
    status_failed: 'Échoué',
    noPostsFilter: 'Aucune publication pour ce filtre.',
    edit: 'Modifier',
    retry: 'Réessayer',
    retrying: 'Tentative…',
    retryStarted: 'Nouvelle tentative lancée.',
    retryFail: 'La tentative a échoué.',
    delete: 'Supprimer',
    deleteFail: 'La suppression a échoué.',
    confirmDelete: 'Supprimer cette publication ?',
    scheduledAt: 'Programmé :',
    publishedAt: 'Publié :',
    hasMedia: 'Avec média',
    publishedLog: 'Journal des publications',
    analytics: 'Analytique',
    noLog: 'Aucune publication pour le moment.',
    postId: 'ID :',
    selectNetwork: 'Réseau :',
    analyticsData: 'Données analytiques',
    analyticsUnavailable: 'Analytique non disponible pour ce réseau',
    analyticsUnavailableHint: "Composio n'expose pas encore d'action d'insights pour ce réseau.",
    postDetail: 'Détail de la publication',
    reschedule: 'Reprogrammer :',
    rescheduleBtn: 'Reprogrammer',
    rescheduled: 'Reprogrammé.',
    reschedFail: 'La reprogrammation a échoué.',
    close: 'Fermer',
    networks: 'Réseaux :',
  },
  ar: {
    title: 'السوشيال',
    subtitle: 'استوديو التواصل الاجتماعي بالذكاء الاصطناعي · CDZ Connect · cdz-flash',
    refresh: '↻ تحديث',
    loading: 'جارٍ التحميل…',
    notConfiguredBanner: 'لم يتم تكوين CDZ Connect بعد (COMPOSIO_API_KEY مفقود).',
    notConfigured: 'لم يتم تكوين CDZ Connect بعد.',
    connectNetworks: 'ربط شبكاتك',
    connect: 'ربط',
    connecting: 'جارٍ الربط…',
    disconnect: 'فصل',
    disconnecting: 'جارٍ الفصل…',
    connected: 'مرتبط',
    disconnectedBadge: 'غير مرتبط',
    disconnected: 'تم الفصل.',
    disconnectFail: 'فشل الفصل. حاول مجدداً.',
    connectOpened: 'تم فتح التفويض في علامة تبويب جديدة — أكمله ثم ارجع وانقر تحديث.',
    authUnconfigured: 'غير متاح حتى الآن عبر CDZ Connect.',
    connectFail: 'تعذر الاتصال في الوقت الحالي.',
    mediaRequired: 'الوسائط مطلوبة',
    view_connections: 'الاتصالات',
    view_composer: 'المحرر',
    view_calendar: 'التقويم',
    view_queue: 'قائمة الانتظار',
    view_log: 'السجل',
    view_settings: 'الإعدادات',
    noNetworks: 'قم بتوصيل شبكة واحدة على الأقل من خلال تبويب الاتصالات للتحرير والنشر.',
    // UP1 — إعدادات متقدمة
    settingsIntro: 'تُطبَّق هذه الإعدادات تلقائياً عند النشر: الهاشتاقات الافتراضية، ومعاملات UTM على الروابط، والتعليق الأول، وقواعد قائمة الانتظار.',
    settingsSaved: 'تم حفظ الإعدادات.',
    settingsFail: 'فشل الحفظ. حاول مجدداً.',
    saveSettings: 'حفظ الإعدادات',
    saving: 'جارٍ الحفظ…',
    reset: 'إعادة تعيين',
    timezone: 'المنطقة الزمنية',
    timezoneDesc: 'تُستخدم لنوافذ النشر.',
    networkDefaults: 'إعدادات كل شبكة',
    networkDefaultsDesc: 'الهاشتاقات والتعليق الأول والأوقات المفضلة لكل شبكة.',
    defaultHashtags: 'الهاشتاقات الافتراضية',
    addHashtag: 'أضف هاشتاقات (Enter)',
    noHashtags: 'لا شيء',
    firstComment: 'التعليق الأول',
    firstCommentHint: 'يُنشر كتعليق مباشرةً بعد المنشور (مثل: الرابط في البايو، هاشتاقات إضافية)…',
    charLimitLabel: 'حد الشبكة',
    postingWindows: 'أوقات النشر المفضلة',
    suggestionLabel: 'اقتراحات:',
    suggestionHint: 'اقتراح (تقديري، وليس إحصاءات حسابك)',
    windowsShort: 'أوقات',
    hasFirstComment: 'تعليق',
    utmTitle: 'معاملات UTM (الروابط)',
    utmDesc: 'تُضاف تلقائياً إلى أول رابط في كل منشور.',
    utmEnable: 'تفعيل وسم UTM',
    utmMediumHint: '(الشبكة)',
    queueRules: 'قواعد قائمة الانتظار',
    queueRulesDesc: 'الوتيرة والتباعد والموافقة على المنشورات.',
    maxPerDay: 'الحد الأقصى للمنشورات/يوم/شبكة',
    unlimited: 'غير محدود',
    minGap: 'الحد الأدنى للفارق (دقائق)',
    autoRequeue: 'إعادة الجدولة تلقائياً عند الفشل (تراجع أسي)',
    autoRequeueMax: 'أقصى عدد للمحاولات التلقائية',
    approvalRequired: 'الموافقة مطلوبة (مسودة ← بانتظار ← مجدولة)',
    // UP1 — إضافات المحرر / القائمة / السجل
    firstCommentField: 'التعليق الأول (اختياري)',
    firstCommentFieldHint: 'يُنشر كتعليق بعد المنشور الرئيسي.',
    bestTime: 'أفضل وقت:',
    bestTimeHint: 'اقتراح — يملأ تاريخ الجدولة.',
    submitApproval: 'إرسال للموافقة',
    approve: 'موافقة',
    approving: 'جارٍ الموافقة…',
    approved: 'تمت الموافقة.',
    approveFail: 'فشلت الموافقة.',
    pendingApproval: 'بانتظار الموافقة',
    variantTabMaster: 'النص الرئيسي',
    queueRuleBlocked: 'محظور بقاعدة قائمة الانتظار:',
    connStatusActive: 'نشط',
    connStatusPending: 'بانتظار…',
    connStatusExpired: 'منتهٍ',
    connStatusFailed: 'فشل',
    errorDetail: 'تفاصيل الخطأ',
    attempts: 'محاولات',
    action: 'الإجراء',
    tab_compose: 'كتابة',
    tab_ai: 'ذكاء اصطناعي',
    tab_media: 'وسائط',
    tab_preview: 'معاينة',
    publishTo: 'النشر على:',
    baseCaption: 'النص الأساسي',
    captionPlaceholder: 'اكتب منشورك هنا…',
    perNetworkOverrides: 'نصوص مخصصة لكل شبكة (اختياري)',
    overridePlaceholder: 'نص مخصص لهذه الشبكة (اتركه فارغاً لاستخدام النص الأساسي)',
    scheduleAt: 'الجدولة في:',
    scheduleFuture: 'يجب أن يكون التاريخ في المستقبل.',
    scheduled: 'تمت جدولة المنشور.',
    draftSaved: 'تم حفظ المسودة.',
    published: 'تم النشر!',
    submitFail: 'فشل العملية. حاول مجدداً.',
    saveDraft: 'حفظ المسودة',
    schedule: 'جدولة',
    publishNow: 'نشر الآن',
    cancel: 'إلغاء',
    mediaRequiredWarning: 'الوسائط مطلوبة لـ:',
    mediaRequiredFor: 'الوسائط مطلوبة لـ',
    aiCompose: 'توليد محتوى بالذكاء الاصطناعي',
    briefPlaceholder: 'صف المنشور (مثال: خصم 20٪ على الأحذية هذا الأسبوع)…',
    tone: 'النبرة:',
    hashtags: 'هاشتاق',
    emojiToggle: 'إيموجي',
    perNetwork: 'متغيرات لكل شبكة',
    generateContent: '✨ توليد المحتوى',
    generating: 'جارٍ التوليد…',
    aiNotConfigured: 'توليد الذكاء الاصطناعي غير مكوّن على هذا الخادم.',
    genOk: 'تم إنشاء المسودة — راجعها قبل النشر.',
    genFail: 'تعذر التوليد — حاول مجدداً.',
    media: 'الوسائط',
    uploadFile: 'رفع ملف',
    or: 'أو',
    aiImageBelow: 'توليد بالذكاء الاصطناعي أدناه',
    aiImage: 'توليد صورة مع CDZIM AI',
    imgPromptPlaceholder: 'صف الصورة المراد توليدها…',
    imgGenOk: 'تم إنشاء الصورة وإضافتها.',
    imgGenFail: 'فشل توليد الصورة. حاول مجدداً.',
    generate: 'توليد',
    emoji: 'إيموجي:',
    preview: 'معاينة',
    selectNetworksFirst: 'اختر الشبكات أعلاه لرؤية المعاينات.',
    status_all: 'الكل',
    status_draft: 'مسودة',
    'status_pending-approval': 'بانتظار الموافقة',
    status_scheduled: 'مجدولة',
    status_publishing: 'قيد النشر',
    status_published: 'منشور',
    status_partial: 'جزئي',
    status_failed: 'فاشل',
    noPostsFilter: 'لا توجد منشورات لهذا الفلتر.',
    edit: 'تعديل',
    retry: 'إعادة المحاولة',
    retrying: 'جارٍ المحاولة…',
    retryStarted: 'بدأت إعادة المحاولة.',
    retryFail: 'فشلت إعادة المحاولة.',
    delete: 'حذف',
    deleteFail: 'فشل الحذف.',
    confirmDelete: 'هل تريد حذف هذا المنشور؟',
    scheduledAt: 'مجدولة:',
    publishedAt: 'نُشر في:',
    hasMedia: 'يحتوي وسائط',
    publishedLog: 'سجل النشر',
    analytics: 'التحليلات',
    noLog: 'لا توجد منشورات منشورة بعد.',
    postId: 'ID:',
    selectNetwork: 'الشبكة:',
    analyticsData: 'بيانات التحليلات',
    analyticsUnavailable: 'التحليلات غير متاحة لهذه الشبكة',
    analyticsUnavailableHint: 'لا تعرض Composio إجراء رؤى لهذه الشبكة بعد.',
    postDetail: 'تفاصيل المنشور',
    reschedule: 'إعادة الجدولة:',
    rescheduleBtn: 'إعادة جدولة',
    rescheduled: 'تمت إعادة الجدولة.',
    reschedFail: 'فشلت إعادة الجدولة.',
    close: 'إغلاق',
    networks: 'الشبكات:',
  },
  en: {
    title: 'Social',
    subtitle: 'AI social media studio · CDZ Connect · cdz-flash',
    refresh: '↻ Refresh',
    loading: 'Loading...',
    notConfiguredBanner: 'CDZ Connect is not configured (COMPOSIO_API_KEY missing on server).',
    notConfigured: 'CDZ Connect is not configured.',
    connectNetworks: 'Connect your networks',
    connect: 'Connect',
    connecting: 'Connecting...',
    disconnect: 'Disconnect',
    disconnecting: 'Disconnecting...',
    connected: 'Connected',
    disconnectedBadge: 'Not connected',
    disconnected: 'Disconnected.',
    disconnectFail: 'Disconnect failed. Try again.',
    connectOpened: 'Auth opened in a new tab — complete it, then come back and click Refresh.',
    authUnconfigured: 'is not yet available via CDZ Connect.',
    connectFail: 'Connection failed. Try again.',
    mediaRequired: 'Media required',
    view_connections: 'Connections',
    view_composer: 'Compose',
    view_calendar: 'Calendar',
    view_queue: 'Queue',
    view_log: 'Log',
    view_settings: 'Settings',
    noNetworks: 'Connect at least one network in the Connections tab to compose and publish.',
    // UP1 — advanced settings
    settingsIntro: 'These settings apply automatically at publish time: default hashtags, UTM link parameters, first comment, and queue rules.',
    settingsSaved: 'Settings saved.',
    settingsFail: 'Save failed. Try again.',
    saveSettings: 'Save settings',
    saving: 'Saving...',
    reset: 'Reset',
    timezone: 'Timezone',
    timezoneDesc: 'Used for posting windows.',
    networkDefaults: 'Per-network defaults',
    networkDefaultsDesc: 'Hashtags, first comment and preferred windows per network.',
    defaultHashtags: 'Default hashtags',
    addHashtag: 'Add hashtags (Enter)',
    noHashtags: 'None',
    firstComment: 'First comment',
    firstCommentHint: 'Posted as a comment right after the post (e.g. link in bio, extra hashtags)...',
    charLimitLabel: 'Network limit',
    postingWindows: 'Preferred posting windows',
    suggestionLabel: 'Suggestions:',
    suggestionHint: 'Suggestion (heuristic, not your account analytics)',
    windowsShort: 'windows',
    hasFirstComment: '1st comment',
    utmTitle: 'UTM parameters (links)',
    utmDesc: 'Appended automatically to the first link in each post.',
    utmEnable: 'Enable UTM tagging',
    utmMediumHint: '(network)',
    queueRules: 'Queue rules',
    queueRulesDesc: 'Cadence, spacing and approval of posts.',
    maxPerDay: 'Max posts / day / network',
    unlimited: 'unlimited',
    minGap: 'Minimum gap (minutes)',
    autoRequeue: 'Auto-requeue on failure (exponential backoff)',
    autoRequeueMax: 'Max auto attempts',
    approvalRequired: 'Approval required (draft → pending → scheduled)',
    // UP1 — composer / queue / log additions
    firstCommentField: 'First comment (optional)',
    firstCommentFieldHint: 'Posted as a comment after the main post.',
    bestTime: 'Best time:',
    bestTimeHint: 'Suggestion — fills the schedule date.',
    submitApproval: 'Submit for approval',
    approve: 'Approve',
    approving: 'Approving...',
    approved: 'Approved.',
    approveFail: 'Approval failed.',
    pendingApproval: 'Pending approval',
    variantTabMaster: 'Master text',
    queueRuleBlocked: 'Blocked by a queue rule:',
    connStatusActive: 'Active',
    connStatusPending: 'Pending...',
    connStatusExpired: 'Expired',
    connStatusFailed: 'Failed',
    errorDetail: 'Error detail',
    attempts: 'attempts',
    action: 'Action',
    tab_compose: 'Write',
    tab_ai: 'AI',
    tab_media: 'Media',
    tab_preview: 'Preview',
    publishTo: 'Publish to:',
    baseCaption: 'Base caption',
    captionPlaceholder: 'Write your post here...',
    perNetworkOverrides: 'Per-network text overrides (optional)',
    overridePlaceholder: 'Custom text for this network (leave blank to use base caption)',
    scheduleAt: 'Schedule at:',
    scheduleFuture: 'Date must be in the future.',
    scheduled: 'Post scheduled.',
    draftSaved: 'Draft saved.',
    published: 'Published!',
    submitFail: 'Failed. Try again.',
    saveDraft: 'Save draft',
    schedule: 'Schedule',
    publishNow: 'Publish now',
    cancel: 'Cancel',
    mediaRequiredWarning: 'Media required for:',
    mediaRequiredFor: 'Media required for',
    aiCompose: 'AI content generation',
    briefPlaceholder: 'Describe the post (e.g. "20% promo on sneakers this weekend")...',
    tone: 'Tone:',
    hashtags: 'Hashtags',
    emojiToggle: 'Emoji',
    perNetwork: 'Per-network variants',
    generateContent: '✨ Generate content',
    generating: 'Generating...',
    aiNotConfigured: 'AI generation is not configured on this server.',
    genOk: 'Draft generated — review before publishing.',
    genFail: 'Generation failed. Try again.',
    media: 'Media',
    uploadFile: 'Upload file',
    or: 'or',
    aiImageBelow: 'generate with AI below',
    aiImage: 'Generate image with CDZIM AI',
    imgPromptPlaceholder: 'Describe the image to generate...',
    imgGenOk: 'Image generated and added.',
    imgGenFail: 'Image generation failed. Try again.',
    generate: 'Generate',
    emoji: 'Emoji:',
    preview: 'Preview',
    selectNetworksFirst: 'Select networks above to see previews.',
    status_all: 'All',
    status_draft: 'Draft',
    'status_pending-approval': 'Pending approval',
    status_scheduled: 'Scheduled',
    status_publishing: 'Publishing',
    status_published: 'Published',
    status_partial: 'Partial',
    status_failed: 'Failed',
    noPostsFilter: 'No posts matching this filter.',
    edit: 'Edit',
    retry: 'Retry',
    retrying: 'Retrying...',
    retryStarted: 'Retry started.',
    retryFail: 'Retry failed.',
    delete: 'Delete',
    deleteFail: 'Delete failed.',
    confirmDelete: 'Delete this post?',
    scheduledAt: 'Scheduled:',
    publishedAt: 'Published:',
    hasMedia: 'Has media',
    publishedLog: 'Published log',
    analytics: 'Analytics',
    noLog: 'No published posts yet.',
    postId: 'Post ID:',
    selectNetwork: 'Network:',
    analyticsData: 'Analytics data',
    analyticsUnavailable: 'Analytics not available for this network',
    analyticsUnavailableHint: 'Composio does not expose an insights action for this network yet.',
    postDetail: 'Post detail',
    reschedule: 'Reschedule:',
    rescheduleBtn: 'Reschedule',
    rescheduled: 'Rescheduled.',
    reschedFail: 'Reschedule failed.',
    close: 'Close',
    networks: 'Networks:',
  },
};

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

type View = 'connections' | 'composer' | 'calendar' | 'queue' | 'log' | 'settings';

const VIEWS: View[] = ['connections', 'composer', 'calendar', 'queue', 'log', 'settings'];

// ---------------------------------------------------------------------------
// SocialPlusPanel — shell with view switcher.
// Signature intentionally preserved so socialplus/index.tsx and dashboard.tsx
// keep working without changes.
// ---------------------------------------------------------------------------

export const SocialPlusPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  const [lang, setLang] = useState<Lang>('fr');
  const [view, setView] = useState<View>('connections');
  const [connectedNetworks, setConnectedNetworks] = useState<string[]>([]);
  // UP1 — active-mode config (composio configured? AI configured?)
  const [config, setConfig] = useState<SocialConfig | null>(null);
  // editPost carries a post when the user clicks Edit in the Queue
  const [editPost, setEditPost] = useState<SocialPost | undefined>(undefined);
  // initialScheduledAt for when user clicks a calendar day
  const [initScheduledAt, setInitScheduledAt] = useState<number | undefined>(undefined);
  // trigger a refresh counter for child views that poll on a shared signal
  const [refreshSignal, setRefreshSignal] = useState(0);

  const dict = DICT[lang];
  const rtl = lang === 'ar';

  // Load connected networks once for the composer selector
  const refreshConnected = useCallback(async () => {
    try {
      const resp = await fetchAccounts();
      if (resp.enabled) {
        setConnectedNetworks(resp.accounts.filter(a => a.connected).map(a => a.network));
      } else {
        setConnectedNetworks([]);
      }
    } catch {
      setConnectedNetworks([]);
    }
  }, []);

  useEffect(() => {
    ensureShoperpResponsiveCss();
    void refreshConnected();
    // UP1 — load the config once so the header can reflect the active mode.
    void fetchConfig().then(setConfig).catch(() => setConfig(null));
  }, [slug, refreshConnected]);

  const handleSaved = useCallback((post: SocialPost) => {
    setEditPost(undefined);
    setInitScheduledAt(undefined);
    onMutated();
    setRefreshSignal(s => s + 1);
    // Stay in composer for review; user can navigate away manually
    void refreshConnected();
    void post; // satisfy linter
  }, [onMutated, refreshConnected]);

  const handleEditPost = useCallback((post: SocialPost) => {
    setEditPost(post);
    setInitScheduledAt(undefined);
    setView('composer');
  }, []);

  const handleNewAtTime = useCallback((scheduledAt: number) => {
    setEditPost(undefined);
    setInitScheduledAt(scheduledAt);
    setView('composer');
  }, []);

  const navStyle = (v: View) => ({
    fontSize: 12,
    fontWeight: view === v ? 700 : 500,
    padding: '6px 15px',
    borderRadius: 999,
    border: 'none',
    cursor: 'pointer',
    background: view === v ? C.accent : 'transparent',
    color: view === v ? '#fff' : C.muted,
    whiteSpace: 'nowrap' as const,
    transition: 'color 160ms ease, background 160ms ease',
  });

  const langBtnStyle = (l: Lang) => ({
    fontSize: 11,
    padding: '4px 11px',
    borderRadius: 999,
    border: `1px solid ${lang === l ? C.accent : C.border}`,
    background: lang === l ? C.accentSoft : 'transparent',
    color: lang === l ? C.accent : C.muted,
    cursor: 'pointer',
    fontWeight: lang === l ? 700 : 500,
    transition: 'color 160ms ease, border-color 160ms ease, background 160ms ease',
  });

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span aria-hidden style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', fontSize: 16, flexShrink: 0, background: 'linear-gradient(135deg, var(--affine-primary-color, #1e96eb), color-mix(in srgb, var(--affine-primary-color, #1e96eb) 70%, #000))', border: `1px solid ${C.border}` }}>
          {'📱'}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text, direction: rtl ? 'rtl' : undefined }}>
            {dict.title}
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, direction: rtl ? 'rtl' : undefined }}>
            {dict.subtitle}
          </div>
        </div>
        {/* Lang switcher */}
        <div style={{ display: 'flex', gap: 4 }}>
          {(['fr', 'ar', 'en'] as Lang[]).map(l => (
            <button key={l} style={langBtnStyle(l)} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <button style={miniBtnStyle('secondary')} onClick={() => { void refreshConnected(); setRefreshSignal(s => s + 1); }}>
          {dict.refresh}
        </button>
      </div>

      {/* Navigation */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 16px', background: C.panel, borderBottom: `1px solid ${C.border}`, overflowX: 'auto' }}>
        {VIEWS.map(v => (
          <button key={v} style={navStyle(v)} onClick={() => { setView(v); if (v !== 'composer') { setEditPost(undefined); setInitScheduledAt(undefined); } }}>
            {dict[`view_${v}`] ?? v}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', background: C.bg }}>
        {readOnly && (
          <Banner tone="warn">
            {'Mode lecture seule — les modifications sont bloquées.'}
          </Banner>
        )}

        {/* UP1 — active-mode banner. Composio drives posting; when it's absent
            everything is dark, but the Réglages tab still works (settings persist
            regardless). AI drives content generation independently. */}
        {config && !config.composioConfigured && view !== 'settings' && (
          <div style={{ marginBottom: 12 }}>
            <Banner tone="error">{dict.notConfiguredBanner}</Banner>
          </div>
        )}

        {view === 'connections' && (
          <ConnectionsView lang={lang} dict={dict} />
        )}

        {view === 'composer' && (
          <ComposerView
            lang={lang}
            dict={dict}
            connectedNetworks={connectedNetworks}
            editPost={editPost}
            initialScheduledAt={initScheduledAt}
            onSaved={handleSaved}
            onCancel={editPost ? () => { setEditPost(undefined); setView('queue'); } : undefined}
          />
        )}

        {view === 'calendar' && (
          <CalendarView
            lang={lang}
            dict={dict}
            onNewAtTime={handleNewAtTime}
            refresh={refreshSignal}
          />
        )}

        {view === 'queue' && (
          <QueueView
            lang={lang}
            dict={dict}
            onEdit={handleEditPost}
            refresh={refreshSignal}
          />
        )}

        {view === 'log' && (
          <LogView
            lang={lang}
            dict={dict}
            refresh={refreshSignal}
          />
        )}

        {view === 'settings' && (
          <SettingsView
            lang={lang}
            dict={dict}
            connectedNetworks={connectedNetworks}
          />
        )}
      </div>
    </div>
  );
};
