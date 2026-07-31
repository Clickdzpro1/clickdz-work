/**
 * ClickDz Mobile — Shared Color Palette
 *
 * All inline styles reference this palette to stay consistent with the CDZ brand.
 * Key surfaces: #0A0A0A (app bg), #1A1A2E (card), #16213E (surface alt),
 * #E2B859 (accent gold), #FFFFFF (text primary), #6B7280 (text muted).
 *
 * Sections:
 *   Backgrounds, Accent, Text, Borders & Dividers, Status Chips,
 *   Action Buttons, Tab Bar, Overlay/Backdrop, Caisse (Cash Register),
 *   Swipe Review, Agent Chat, Misc
 */

export const MOBILE_COLORS = {
  // ── Backgrounds ─────────────────────────────────────────────────────────────
  appBg:           '#0A0A0A',
  surface:         '#1A1A2E',
  surfaceAlt:      '#16213E',
  surfaceHover:    '#1F2F4A',
  elevated:        '#222240',

  // ── Accent ──────────────────────────────────────────────────────────────────
  accent:          '#E2B859',   // gold
  accentMuted:     'rgba(226, 184, 89, 0.15)',
  accentHover:     '#C9A03A',

  // ── Text ────────────────────────────────────────────────────────────────────
  textPrimary:     '#FFFFFF',
  textSecondary:   '#9CA3AF',
  textMuted:       '#6B7280',
  textInverse:     '#0A0A0A',

  // ── Borders & Dividers ──────────────────────────────────────────────────────
  border:          'rgba(255, 255, 255, 0.08)',
  borderStrong:    'rgba(255, 255, 255, 0.14)',
  divider:         'rgba(255, 255, 255, 0.06)',

  // ── Status Chips ────────────────────────────────────────────────────────────
  statusPending:   '#F59E0B',   // amber
  statusConfirmed: '#3B82F6',   // blue
  statusProcessing:'#8B5CF6',   // violet
  statusShipped:   '#06B6D4',   // cyan
  statusDelivered: '#10B981',   // emerald
  statusCancelled: '#EF4444',   // red
  statusRefunded:  '#6B7280',   // gray
  statusReturned:  '#F97316',   // orange

  // ── Action Buttons ──────────────────────────────────────────────────────────
  actionShip:      '#10B981',   // green
  actionWaybill:   '#3B82F6',   // blue
  actionRefund:    '#EF4444',   // red

  // ── Tab Bar ─────────────────────────────────────────────────────────────────
  tabBarBg:        '#12121F',
  tabActive:       '#E2B859',
  tabInactive:     '#6B7280',
  tabBarBorder:    'rgba(255, 255, 255, 0.06)',

  // ── Overlay / Backdrop ──────────────────────────────────────────────────────
  backdrop:        'rgba(0, 0, 0, 0.6)',

  // ── Caisse (Cash Register) ───────────────────────────────────────────────────
  // Validation — green encaissement
  caisseValidateBg:        '#10B981',
  caisseValidateText:      '#FFFFFF',
  caisseValidateBorder:    'rgba(16, 185, 129, 0.30)',
  caisseValidateMutedBg:   'rgba(16, 185, 129, 0.08)',
  // Reject / décaissement — red
  caisseRejectBg:          'rgba(239, 68, 68, 0.15)',
  caisseRejectText:        '#EF4444',
  caisseRejectBorder:      'rgba(239, 68, 68, 0.25)',
  caisseRejectMutedBg:     'rgba(239, 68, 68, 0.08)',
  // Amount display
  caisseAmountPositive:    '#FFFFFF',
  caisseAmountNegative:    '#EF4444',
  caisseAmountPlaceholder: '#6B7280',
  // Keypad
  caisseKeyDigitBg:        '#16213E',
  caisseKeyDigitText:      '#FFFFFF',
  caisseKeyActionText:     '#9CA3AF',
  caisseKeyCancelText:     '#EF4444',
  // Toggle buttons
  caisseTogglePositiveBg:  'rgba(16, 185, 129, 0.08)',
  caisseTogglePositiveText:'#10B981',
  caisseToggleNegativeBg:  'rgba(239, 68, 68, 0.08)',
  caisseToggleNegativeText:'#EF4444',

  // ── Swipe Review ─────────────────────────────────────────────────────────────
  swipeApproveBg:   '#10B981',
  swipeApproveText: '#FFFFFF',
  swipeRejectBg:    '#EF4444',
  swipeRejectText:  '#FFFFFF',
  swipeApproveTint: 'rgba(16, 185, 129, 0.6)',
  swipeRejectTint:  'rgba(239, 68, 68, 0.6)',

  // ── Agent Chat ───────────────────────────────────────────────────────────────
  chatBubbleUser:   '#E2B859',   // gold — matches accent
  chatBubbleAgent:  '#1A1A2E',   // surface
  chatTypingDot:    '#6B7280',
  chatInputBg:      '#16213E',
  chatInputBorder:  'rgba(255, 255, 255, 0.08)',
  chatSendBtn:      '#E2B859',
  chatAgentOnline:  '#10B981',
  chatAgentBusy:    '#F59E0B',
  chatAgentOffline: '#6B7280',

  // ── Misc ────────────────────────────────────────────────────────────────────
  shadow:          'rgba(0, 0, 0, 0.4)',
  white:           '#FFFFFF',
  black:           '#000000',
} as const;

export type MobileColorKey = keyof typeof MOBILE_COLORS;
