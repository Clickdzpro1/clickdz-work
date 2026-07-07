// ClickDz Work — Template Installer v2 (backward-compatible shim).
// v2 upgrades tracker docs with real affine:database blocks (kanban + table).
// Actual implementation lives in installer-v2.ts; this file re-exports for
// all existing import paths (workspace-boot.tsx, etc.)
export {
  installPendingTemplates,
  ensureTemplateLibrary,
} from './installer-v2';
