/**
 * CDZ Chat — i18n hook.
 *
 * Thin wrapper around `useAFFiNEI18N()` that exposes the CDZ chat keys as a
 * typed object, so the components can use `t.cdz.chat.input.placeholder()`
 * instead of the verbose `t['com.affine.cdz.chat.input.placeholder']()`.
 *
 * Keys are defined in packages/frontend/i18n/src/resources/en.json and
 * typed via the codegen'd i18n.gen.ts. If a key is missing from the resource
 * file, the i18n proxy returns the key string itself (i18next fallback), so
 * the UI never breaks — it just shows the key until the resource ships.
 *
 * Usage:
 *   const t = useCdzI18n();
 *   <input placeholder={t.chat.input.placeholder()} />
 */
import { useAFFiNEI18N } from '@affine/i18n';

export function useCdzI18n() {
  const t = useAFFiNEI18N();
  return {
    chat: {
      input: {
        placeholder: () => t['com.affine.cdz.chat.input.placeholder'](),
        attachFile: () => t['com.affine.cdz.chat.input.attach-file'](),
        extendedThinking: () =>
          t['com.affine.cdz.chat.input.extended-thinking'](),
        send: () => t['com.affine.cdz.chat.input.send'](),
        disclaimer: () => t['com.affine.cdz.chat.input.disclaimer'](),
        analyzedImage: () => t['com.affine.cdz.chat.input.analyzed-image'](),
        analyzedDocument: () =>
          t['com.affine.cdz.chat.input.analyzed-document'](),
        analyzedFiles: (count: string | number) =>
          t['com.affine.cdz.chat.input.analyzed-files']({
            count: String(count),
          }),
        analyzedPasted: () => t['com.affine.cdz.chat.input.analyzed-pasted'](),
      },
      model: {
        select: () => t['com.affine.cdz.chat.model.select'](),
      },
    },
    workers: {
      title: () => t['com.affine.cdz.workers.title'](),
      search: () => t['com.affine.cdz.workers.search'](),
      all: () => t['com.affine.cdz.workers.all'](),
      browse: () => t['com.affine.cdz.workers.browse'](),
      loading: () => t['com.affine.cdz.workers.loading'](),
      error: () => t['com.affine.cdz.workers.error'](),
      noResults: (query: string) =>
        t['com.affine.cdz.workers.no-results']({ query }),
      count: (count: string | number) =>
        t['com.affine.cdz.workers.count']({ count: String(count) }),
      close: () => t['com.affine.cdz.workers.close'](),
      clear: () => t['com.affine.cdz.workers.clear'](),
      answeringAs: (name: string) =>
        t['com.affine.cdz.workers.answering-as']({ name }),
    },
    council: {
      trigger: () => t['com.affine.cdz.council.trigger'](),
      on: () => t['com.affine.cdz.council.on'](),
      enable: () => t['com.affine.cdz.council.enable'](),
      disable: () => t['com.affine.cdz.council.disable'](),
      active: () => t['com.affine.cdz.council.active'](),
    },
  };
}

export type CdzI18n = ReturnType<typeof useCdzI18n>;
