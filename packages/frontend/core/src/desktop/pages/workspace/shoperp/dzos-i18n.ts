// ---------------------------------------------------------------------------
// DzOS ERP i18n — bilingual FR/AR dictionary for the studio panels + print
// sheets. The shoperp surface was built French-only with inline styles and no
// dependency on the app-wide i18next instance (see shoperp-shared.tsx header:
// "no i18n, no new .css.ts"). This module adds Arabic without pulling in
// react-i18next: a flat `dzosT(key, lang?)` lookup + an `isRTL()` helper that
// the panels and print sheets consume.
//
// Design:
//   • `DzosLang = 'fr' | 'ar'` — the two languages the DzOS surface supports.
//   • `dzosT(key)` resolves a dotted key (e.g. 'invoice.type.facture') to the
//     string in the current language. Falls back to FR, then to the raw key.
//   • `useDzosLang()` — a React hook that reads the app-wide i18n language and
//     maps it to 'fr' | 'ar' (anything non-Arabic → 'fr', the deployment
//     default). This lets the ERP panels follow the user's global language
//     preference without each panel calling useTranslation.
//   • `isRTL(lang)` — true for 'ar'; used by print sheets to flip layout.
//   • `dzosDir(lang)` — returns 'rtl' | 'ltr'.
//   • Label maps (INVOICE_TYPE_LABELS etc. in shoperp-shared) are NOT touched;
//     their bilingual equivalents live here as `dzosInvoiceTypeLabels` etc.
//     Panels that need bilingual labels import from here; panels that don't
//     (internal-only surfaces) keep using the originals.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';

// Re-exported by shoperp panels that need to know the script direction.
export type DzosLang = 'fr' | 'ar';

export function isRTL(lang: DzosLang): boolean {
  return lang === 'ar';
}

export function dzosDir(lang: DzosLang): 'rtl' | 'ltr' {
  return isRTL(lang) ? 'rtl' : 'ltr';
}

// ---------------------------------------------------------------------------
// The dictionary. Flat dotted keys, grouped by domain for readability. Every
// key has a `fr` and an `ar` entry. Arabic translations use formal Algerian
// business Arabic (fosha with DZ fiscal terminology).
// ---------------------------------------------------------------------------
type Dict = Record<string, { fr: string; ar: string }>;

const DICT: Dict = {
  // ── Dashboard tab labels ────────────────────────────────────────────────
  'tab.overview': { fr: 'Aperçu', ar: 'نظرة عامة' },
  'tab.orders': { fr: 'Commandes', ar: 'الطلبات' },
  'tab.stock': { fr: 'Produits', ar: 'المنتجات' },
  'tab.inventory': { fr: 'Entrepôts', ar: 'المخازن' },
  'tab.clients': { fr: 'Clients', ar: 'العملاء' },
  'tab.appearance': { fr: 'Apparence', ar: 'المظهر' },
  'tab.features': { fr: 'Fonctionnalités', ar: 'الميزات' },
  'tab.aiEdit': { fr: "Modifier avec l'IA", ar: 'تعديل بالذكاء الاصطناعي' },
  'tab.invoicing': { fr: 'Facturation', ar: 'الفوترة' },
  'tab.procurement': { fr: 'Fournisseurs', ar: 'الموردون' },
  'tab.shipping': { fr: 'Livraison', ar: 'التوصيل' },
  'tab.caisse': { fr: 'Caisse', ar: 'الصندوق' },
  'tab.reports': { fr: 'Rapports', ar: 'التقارير' },
  'tab.comptabilite': { fr: 'Comptabilité', ar: 'المحاسبة' },
  'tab.team': { fr: 'Équipe', ar: 'الفريق' },
  'tab.settings': { fr: 'Réglages', ar: 'الإعدادات' },

  // ── Caisse tab labels ───────────────────────────────────────────────────
  'caisse.tab.journal': { fr: 'Journal', ar: 'السجل' },
  'caisse.tab.reconcile': { fr: 'Rapprochement COD', ar: 'مطابقة الدفع عند الاستلام' },
  'caisse.tab.dayclose': { fr: 'Clôture du jour', ar: 'إغلاق اليوم' },

  // ── Caisse method labels ────────────────────────────────────────────────
  'caisse.method.cash': { fr: 'Espèces', ar: 'نقداً' },
  'caisse.method.cod': { fr: 'COD (livraison)', ar: 'الدفع عند التوصيل' },
  'caisse.method.chargily': { fr: 'Chargily (en ligne)', ar: 'Chargily (عبر الإنترنت)' },

  // ── Caisse day-close labels ─────────────────────────────────────────────
  'caisse.dayclose.title': { fr: 'Clôture du jour', ar: 'إغلاق اليوم' },
  'caisse.dayclose.inByMethod': { fr: 'Entrées par méthode', ar: 'الإيرادات حسب طريقة الدفع' },
  'caisse.dayclose.outByMethod': { fr: 'Sorties par méthode', ar: 'المصروفات حسب طريقة الدفع' },
  'caisse.dayclose.net': { fr: 'Net', ar: 'الصافي' },
  'caisse.dayclose.copySummary': { fr: 'Copier le résumé', ar: 'نسخ الملخص' },
  'caisse.dayclose.copied': { fr: 'Résumé copié ✅', ar: 'تم نسخ الملخص ✅' },

  // ── Caisse journal labels ───────────────────────────────────────────────
  'caisse.journal.title': { fr: 'Journal', ar: 'السجل' },
  'caisse.journal.addEntry': { fr: 'Ajouter une écriture', ar: 'إضافة قيد' },
  'caisse.journal.kind.in': { fr: 'Entrée', ar: 'إيراد' },
  'caisse.journal.kind.out': { fr: 'Sortie', ar: 'مصروف' },
  'caisse.journal.amount': { fr: 'Montant', ar: 'المبلغ' },
  'caisse.journal.method': { fr: 'Méthode', ar: 'طريقة الدفع' },
  'caisse.journal.courier': { fr: 'Livreur', ar: 'الموصّل' },
  'caisse.journal.note': { fr: 'Note', ar: 'ملاحظة' },
  'caisse.journal.pending': { fr: 'En attente COD', ar: 'في انتظار الدفع عند الاستلام' },

  // ── Caisse reconcile labels ─────────────────────────────────────────────
  'caisse.reconcile.title': { fr: 'Rapprochement COD par livreur', ar: 'مطابقة الدفع عند الاستلام حسب الموصّل' },
  'caisse.reconcile.expected': { fr: 'Attendu', ar: 'المتوقع' },
  'caisse.reconcile.received': { fr: 'Reçu', ar: 'المستلم' },
  'caisse.reconcile.gap': { fr: 'Écart', ar: 'الفرق' },
  'caisse.reconcile.codFee': { fr: 'Frais COD', ar: 'رسوم الدفع عند الاستلام' },
  'caisse.reconcile.deliveries': { fr: 'Livraisons', ar: 'التوصيلات' },
  'caisse.reconcile.collect': { fr: 'Encaisser', ar: 'تحصيل' },

  // ── Invoice document type labels ────────────────────────────────────────
  'invoice.type.devis': { fr: 'Devis', ar: 'عرض سعر' },
  'invoice.type.bl': { fr: 'Bon de livraison', ar: 'سند التوصيل' },
  'invoice.type.facture': { fr: 'Facture', ar: 'فاتورة' },

  // ── Invoice status labels ───────────────────────────────────────────────
  'invoice.status.brouillon': { fr: 'Brouillon', ar: 'مسودة' },
  'invoice.status.valide': { fr: 'Validée', ar: 'مصادق عليها' },
  'invoice.status.annule': { fr: 'Annulée', ar: 'ملغاة' },

  // ── Invoice payment labels ──────────────────────────────────────────────
  'invoice.payment.cash': { fr: 'Espèces', ar: 'نقداً' },
  'invoice.payment.cod': { fr: 'Paiement à la livraison', ar: 'الدفع عند التوصيل' },
  'invoice.payment.chargily': { fr: 'En ligne (Chargily)', ar: 'عبر الإنترنت (Chargily)' },
  'invoice.payment.virement': { fr: 'Virement bancaire', ar: 'تحويل بنكي' },
  'invoice.payment.cheque': { fr: 'Chèque', ar: 'شيك' },
  'invoice.payment.ccp': { fr: 'CCP / Mandat', ar: 'بريد / حوالة' },
  'invoice.payment.edahabia': { fr: 'Edahabia', ar: 'الذهبية' },
  'invoice.payment.cib': { fr: 'Carte CIB', ar: 'بطاقة CIB' },

  // ── Invoice editor labels ───────────────────────────────────────────────
  'invoice.editor.title': { fr: 'Factures', ar: 'الفواتير' },
  'invoice.editor.back': { fr: '← Factures', ar: '→ الفواتير' },
  'invoice.editor.newDoc': { fr: 'Nouveau document', ar: 'وثيقة جديدة' },
  'invoice.editor.draftSuffix': { fr: '(brouillon)', ar: '(مسودة)' },
  'invoice.editor.printBtn': { fr: '🖨️ Imprimer / PDF', ar: '🖨️ طباعة / PDF' },
  'invoice.editor.printTitle': {
    fr: 'Imprimer ou enregistrer en PDF (format A4)',
    ar: 'طباعة أو حفظ كملف PDF (مقاس A4)',
  },
  'invoice.editor.docType': { fr: 'Type de document', ar: 'نوع الوثيقة' },
  'invoice.editor.typeLabel': { fr: 'Type', ar: 'النوع' },
  'invoice.editor.client': { fr: 'Client', ar: 'العميل' },
  'invoice.editor.lines': { fr: 'Lignes', ar: 'البنود' },
  'invoice.editor.showFiscal': { fr: 'Champs fiscaux (RC/NIF…)', ar: 'الحقول الجبائية (سجل تجاري/معرف جبائي…)' },
  'invoice.editor.hideFiscal': { fr: 'Masquer les champs fiscaux', ar: 'إخفاء الحقول الجبائية' },
  'invoice.editor.clientName': { fr: 'Nom / Raison sociale', ar: 'الاسم / الصفة القانونية' },
  'invoice.editor.clientNamePh': {
    fr: 'Ex. SARL Exemple / Client comptoir',
    ar: 'مثال: شركة ذات مسؤولية محدودة / عميل نقدي',
  },
  'invoice.editor.address': { fr: 'Adresse', ar: 'العنوان' },
  'invoice.editor.addressPh': { fr: 'Adresse du client', ar: 'عنوان العميل' },
  'invoice.editor.rc': { fr: 'RC', ar: 'سجل تجاري' },
  'invoice.editor.rcPh': { fr: 'Registre de commerce', ar: 'السجل التجاري' },
  'invoice.editor.nif': { fr: 'NIF', ar: 'معرف جبائي' },
  'invoice.editor.nifPh': { fr: "N° d'identification fiscale", ar: 'رقم التعريف الجبائي' },
  'invoice.editor.nis': { fr: 'NIS', ar: 'معرف إحصائي' },
  'invoice.editor.nisPh': { fr: "N° d'identification statistique", ar: 'رقم التعريف الإحصائي' },
  'invoice.editor.art': { fr: "Art. (article d'imposition)", ar: 'المادة (مادة فرض الضريبة)' },
  'invoice.editor.createfromOrder': { fr: '📦 Créer depuis une commande', ar: '📦 إنشاء من طلب' },
  'invoice.editor.saveDraft': { fr: 'Enregistrer le brouillon', ar: 'حفظ المسودة' },
  'invoice.editor.validate': { fr: '✅ Valider', ar: '✅ مصادقة' },
  'invoice.editor.validateTitle': {
    fr: 'Attribue le numéro légal (gap-less) et fige le document',
    ar: 'يعين الرقم القانوني (متتابع) ويثبت الوثيقة',
  },
  'invoice.editor.void': { fr: '❌ Annuler le document', ar: '❌ إلغاء الوثيقة' },
  'invoice.editor.convert': { fr: '🔄 Convertir', ar: '🔄 تحويل' },
  'invoice.editor.deleteLine': { fr: 'Supprimer la ligne', ar: 'حذف البند' },
  'invoice.editor.readonly': {
    fr: "Les écritures sont désactivées sur ce serveur — cet éditeur est en lecture seule.",
    ar: 'القيد معطّل على هذا الخادم — هذا المحرر للقراءة فقط.',
  },
  'invoice.editor.lockedValide': {
    fr: "Document validé (numéro légal attribué) — non modifiable. Vous pouvez l'imprimer, l'annuler ou le convertir.",
    ar: 'وثيقة مصادق عليها (رقم قانوني معين) — غير قابلة للتعديل. يمكنك طباعتها أو إلغاؤها أو تحويلها.',
  },
  'invoice.editor.lockedAnnule': {
    fr: 'Document annulé — conservé pour la traçabilité légale.',
    ar: 'وثيقة ملغاة — محفوظة للتتبع القانوني.',
  },
  'invoice.editor.timbreHint': {
    fr: 'Un timbre fiscal (1% · min 5 DZD) s\'applique aux factures réglées en espèces / à la livraison.',
    ar: 'يُطبّق طابع جبائي (1% · أدنى 5 دج) على الفواتير المدفوعة نقداً / عند التوصيل.',
  },
  'invoice.editor.showInApp': { fr: "Afficher dans l'app publiée", ar: 'إظهار في التطبيق المنشور' },
  'invoice.editor.showInAppToggle': { fr: "Afficher dans l'app", ar: 'إظهار في التطبيق' },
  'invoice.editor.hideInAppToggle': { fr: "Masquer dans l'app", ar: 'إخفاء من التطبيق' },
  'invoice.editor.sellerIdentity': { fr: 'Identité vendeur (facture)', ar: 'هوية البائع (فاتورة)' },
  'invoice.editor.sellerHint': {
    fr: ' — figure en en-tête et pied de vos factures.',
    ar: ' — يظهر في رأس وذيل فواتيرك.',
  },
  'invoice.editor.sellerIncomplete': {
    fr: 'Renseignez votre raison sociale + RC/NIF/NIS/ART : ils apparaissent sur la facture imprimée (obligatoire légalement).',
    ar: 'أدخل صفتك القانونية + السجل التجاري/المعرف الجبائي/المعرف الإحصائي/المادة: تظهر على الفاتورة المطبوعة (إلزامي قانوناً).',
  },
  'invoice.editor.loadingInvoices': { fr: 'Chargement des factures…', ar: 'تحميل الفواتير…' },
  'invoice.editor.noDocs': {
    fr: 'Aucun document pour ce mois. Créez un devis, un bon de livraison ou une facture — ou changez de mois.',
    ar: 'لا توجد وثائق لهذا الشهر. أنشئ عرض سعر أو سند توصيل أو فاتورة — أو غيّر الشهر.',
  },
  'invoice.editor.sellerIncompleteWarn': {
    fr: 'Identité vendeur incomplète — renseignez raison sociale, RC, NIF, NIS et ART dans Réglages avant de valider une facture (obligatoire légalement).',
    ar: 'هوية البائع غير مكتملة — أدخل الصفة القانونية، السجل التجاري، المعرف الجبائي، المعرف الإحصائي والمادة في الإعدادات قبل مصادقة الفاتورة (إلزامي قانوناً).',
  },
  'invoice.editor.comingSoon': {
    fr: 'sera bientôt disponible sur votre boutique en ligne.',
    ar: 'سيتوفر قريباً في متجرك الإلكتروني.',
  },
  'invoice.editor.cashWarn': {
    fr: 'Attention — facture caisse de',
    ar: 'تنبيه — فاتورة صندوق بقيمة',
  },
  'invoice.editor.cashWarnConfirm': {
    fr: 'Valider quand même cette facture en espèces ?',
    ar: 'هل تريد مصادقة هذه الفاتورة نقداً رغم ذلك؟',
  },
  'invoice.editor.voidConfirm': {
    fr: "Cette action est IRREVERSIBLE : le numéro reste comptabilisé à jamais et le document est marqué « annulé ». Il ne peut plus être réactivé ni réutilisé.\n\nConfirmez-vous l'annulation ?",
    ar: 'هذا الإجراء لا رجعة فيه: يبقى الرقم مسجلاً للأبد وتُعلَّم الوثيقة بـ«ملغاة». لا يمكن إعادة تفعيلها أو إعادة استخدامها.\n\nهل تؤكد الإلغاء؟',
  },
  'invoice.editor.chooseOrder': { fr: 'Choisir une commande', ar: 'اختيار طلب' },

  // ── Invoice print sheet labels ──────────────────────────────────────────
  'print.invoice.yourCompany': { fr: 'Votre entreprise', ar: 'مؤسستك' },
  'print.invoice.tel': { fr: 'Tél', ar: 'هاتف' },
  'print.invoice.rc': { fr: 'RC', ar: 'سجل تجاري' },
  'print.invoice.nif': { fr: 'NIF', ar: 'معرف جبائي' },
  'print.invoice.nis': { fr: 'NIS', ar: 'معرف إحصائي' },
  'print.invoice.art': { fr: 'Art.', ar: 'المادة' },
  'print.invoice.number': { fr: 'N°', ar: 'رقم' },
  'print.invoice.date': { fr: 'Date', ar: 'التاريخ' },
  'print.invoice.void': { fr: 'ANNULÉ', ar: 'ملغاة' },
  'print.invoice.draft': { fr: 'BROUILLON', ar: 'مسودة' },
  'print.invoice.client': { fr: 'Client', ar: 'العميل' },
  'print.invoice.designation': { fr: 'Désignation', ar: 'البيان' },
  'print.invoice.qty': { fr: 'Qté', ar: 'الكمية' },
  'print.invoice.unitHT': { fr: 'PU HT', ar: 'سعر الوحدة قبل الضريبة' },
  'print.invoice.tvaRate': { fr: 'TVA %', ar: 'نسبة الضريبة %' },
  'print.invoice.totalHT': { fr: 'Total HT', ar: 'المجموع قبل الضريبة' },
  'print.invoice.totalTVA': { fr: 'Total TVA', ar: 'مجموع الضريبة' },
  'print.invoice.timbre': { fr: 'Timbre fiscal', ar: 'الطابع الجبائي' },
  'print.invoice.totalTTC': { fr: 'Total TTC', ar: 'المجموع شامل الضريبة' },
  'print.invoice.dontTVA': { fr: 'dont TVA', ar: 'منها الضريبة' },
  'print.invoice.base': { fr: 'base', ar: 'الأساس' },
  'print.invoice.paymentMode': { fr: 'Mode de règlement', ar: 'طريقة الأداء' },
  'print.invoice.printedOn': { fr: 'Imprimé le', ar: 'طُبع في' },

  // ── Ticket / receipt print sheet labels (caisse) ────────────────────────
  'print.ticket.title': { fr: 'TICKET DE CAISSE', ar: 'إيصال صندوق' },
  'print.ticket.receipt': { fr: 'Reçu', ar: 'إيصال' },
  'print.ticket.number': { fr: 'N°', ar: 'رقم' },
  'print.ticket.date': { fr: 'Date', ar: 'التاريخ' },
  'print.ticket.item': { fr: 'Article', ar: 'الصنف' },
  'print.ticket.qty': { fr: 'Qté', ar: 'الكمية' },
  'print.ticket.price': { fr: 'Prix', ar: 'السعر' },
  'print.ticket.total': { fr: 'Total', ar: 'المجموع' },
  'print.ticket.subtotal': { fr: 'Sous-total', ar: 'المجموع الفرعي' },
  'print.ticket.thanks': { fr: 'Merci de votre visite !', ar: 'شكراً لزيارتكم!' },
  'print.ticket.seller': { fr: 'Vendeur', ar: 'البائع' },
  'print.ticket.paymentMethod': { fr: 'Règlement', ar: 'طريقة الأداء' },

  // ── Module labels (erpBackends toggle) ──────────────────────────────────
  'module.factures': { fr: 'Factures', ar: 'الفواتير' },
  'module.livraison': { fr: 'Livraison', ar: 'التوصيل' },
  'module.caisse': { fr: 'Caisse', ar: 'الصندوق' },

  // ── Order status labels ─────────────────────────────────────────────────
  'order.status.nouvelle': { fr: 'Nouvelle', ar: 'جديدة' },
  'order.status.confirmee': { fr: 'Confirmée', ar: 'مؤكدة' },
  'order.status.expediee': { fr: 'Expédiée', ar: 'تم شحنها' },
  'order.status.livree': { fr: 'Livrée', ar: 'تم توصيلها' },
  'order.status.retournee': { fr: 'Retournée', ar: 'مرتجعة' },

  // ── Sync pill labels ────────────────────────────────────────────────────
  'sync.synced': { fr: 'synchronisé', ar: 'مُزامَن' },
  'sync.pending': { fr: 'en attente', ar: 'في الانتظار' },
  'sync.offline': { fr: 'hors ligne', ar: 'غير متصل' },

  // ── Common labels ───────────────────────────────────────────────────────
  'common.loading': { fr: 'Chargement…', ar: 'تحميل…' },
  'common.save': { fr: 'Enregistrer', ar: 'حفظ' },
  'common.cancel': { fr: 'Annuler', ar: 'إلغاء' },
  'common.close': { fr: 'Fermer', ar: 'إغلاق' },
  'common.confirm': { fr: 'Confirmer', ar: 'تأكيد' },
  'common.delete': { fr: 'Supprimer', ar: 'حذف' },
  'common.edit': { fr: 'Modifier', ar: 'تعديل' },
  'common.back': { fr: 'Retour', ar: 'رجوع' },
  'common.search': { fr: 'Rechercher', ar: 'بحث' },
  'common.all': { fr: 'Tous', ar: 'الكل' },
  'common.none': { fr: 'Aucun', ar: 'لا شيء' },
  'common.month': { fr: 'Mois', ar: 'الشهر' },
  'common.date': { fr: 'Date', ar: 'التاريخ' },
  'common.amount': { fr: 'Montant', ar: 'المبلغ' },
  'common.total': { fr: 'Total', ar: 'المجموع' },
  'common.actions': { fr: 'Actions', ar: 'إجراءات' },
};

// ---------------------------------------------------------------------------
// Core lookup: dzosT('invoice.type.facture', 'ar') → 'فاتورة'
// Falls back to FR, then to the raw key (never throws).
// ---------------------------------------------------------------------------
export function dzosT(key: string, lang: DzosLang = 'fr'): string {
  const entry = DICT[key];
  if (!entry) return key;
  return entry[lang] ?? entry.fr ?? key;
}

// ---------------------------------------------------------------------------
// Label maps for the invoice domain — bilingual equivalents of the
// INVOICE_TYPE_LABELS / INVOICE_STATUS_LABELS / INVOICE_PAYMENT_LABELS
// constants in shoperp-shared.tsx. Panels import these when they need to
// render labels in the user's language.
// ---------------------------------------------------------------------------
import type {
  InvoiceType,
  InvoiceStatus,
  InvoicePayment,
  CaisseMethod,
  ModuleId,
  OrderStatus,
} from './shoperp-shared';

export const dzosInvoiceTypeLabels: Record<InvoiceType, (lang: DzosLang) => string> = {
  devis: lang => dzosT('invoice.type.devis', lang),
  bl: lang => dzosT('invoice.type.bl', lang),
  facture: lang => dzosT('invoice.type.facture', lang),
};

export const dzosInvoiceStatusLabels: Record<InvoiceStatus, (lang: DzosLang) => string> = {
  brouillon: lang => dzosT('invoice.status.brouillon', lang),
  valide: lang => dzosT('invoice.status.valide', lang),
  annule: lang => dzosT('invoice.status.annule', lang),
};

export const dzosInvoicePaymentLabels: Record<InvoicePayment, (lang: DzosLang) => string> = {
  cash: lang => dzosT('invoice.payment.cash', lang),
  cod: lang => dzosT('invoice.payment.cod', lang),
  chargily: lang => dzosT('invoice.payment.chargily', lang),
  virement: lang => dzosT('invoice.payment.virement', lang),
  cheque: lang => dzosT('invoice.payment.cheque', lang),
  ccp: lang => dzosT('invoice.payment.ccp', lang),
  edahabia: lang => dzosT('invoice.payment.edahabia', lang),
  cib: lang => dzosT('invoice.payment.cib', lang),
};

export const dzosCaisseMethodLabels: Record<CaisseMethod, (lang: DzosLang) => string> = {
  cash: lang => dzosT('caisse.method.cash', lang),
  cod: lang => dzosT('caisse.method.cod', lang),
  chargily: lang => dzosT('caisse.method.chargily', lang),
};

export const dzosModuleLabels: Record<ModuleId, (lang: DzosLang) => string> = {
  factures: lang => dzosT('module.factures', lang),
  livraison: lang => dzosT('module.livraison', lang),
  caisse: lang => dzosT('module.caisse', lang),
};

export const dzosOrderStatusLabels: Record<OrderStatus, (lang: DzosLang) => string> = {
  Nouvelle: lang => dzosT('order.status.nouvelle', lang),
  Confirmée: lang => dzosT('order.status.confirmee', lang),
  Expédiée: lang => dzosT('order.status.expediee', lang),
  Livrée: lang => dzosT('order.status.livree', lang),
  Retournée: lang => dzosT('order.status.retournee', lang),
};

// ---------------------------------------------------------------------------
// React hook: useDzosLang() → 'fr' | 'ar'
//
// Reads the app-wide i18n language from the <html lang="…"> attribute (kept in
// sync by I18n.applyDocumentLanguage) and maps it to the DzOS two-language
// surface. Arabic (ar, ar-DZ, ar-*) → 'ar'; everything else → 'fr' (the
// deployment default). Re-reads on languageChanged events so panels update
// live when the user switches language in Settings.
// ---------------------------------------------------------------------------
export function useDzosLang(): DzosLang {
  const readLang = (): DzosLang => {
    if (typeof document === 'undefined') return 'fr';
    const htmlLang = document.documentElement.lang || '';
    return htmlLang.startsWith('ar') ? 'ar' : 'fr';
  };

  const [lang, setLang] = useState<DzosLang>(readLang);

  useEffect(() => {
    setLang(readLang());
    // Listen for language changes dispatched by the i18n entity. We observe
    // the <html> attribute directly (the i18n entity sets it in
    // applyDocumentLanguage) so this module stays decoupled from the i18n
    // service internals.
    const observer = new MutationObserver(() => setLang(readLang()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang', 'dir'],
    });
    return () => observer.disconnect();
  }, []);

  return lang;
}

// ---------------------------------------------------------------------------
// Bilingual number formatting: Arabic uses Arabic-Indic digits (٠١٢٣…), but
// for invoices/tickets in Algeria, Western Arabic numerals (0123…) are the
// norm even in Arabic documents. We keep the fr-DZ grouping but append the
// currency label in the active language.
// ---------------------------------------------------------------------------
export function dzosFmtDZD(v: number, lang: DzosLang = 'fr', currency = 'DZD'): string {
  const n = Math.round(v);
  let s: string;
  try {
    s = n.toLocaleString('fr-DZ');
  } catch {
    s = String(n);
  }
  // In Arabic we keep "دج" (the Algerian dinar abbreviation) instead of "DZD"
  const curr = lang === 'ar' ? 'دج' : currency;
  return `${s} ${curr}`;
}
