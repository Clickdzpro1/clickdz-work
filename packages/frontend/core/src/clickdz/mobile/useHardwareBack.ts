/**
 * useHardwareBack — Android Hardware Back Button & Gesture Handler
 *
 * Hermes Wiring Pattern:
 *   Registers a popstate listener stack so that the mobile shell can intercept
 *   hardware back presses (Android) or edge-swipe-back gestures (iOS Safari) in
 *   priority order.
 *
 * Priority order:
 *   1. Close open drawer / bottom sheet
 *   2. Pop sub-route (react-router navigate(-1) — caller responsibility)
 *   3. Confirm unsaved forms (caller responsibility — dismiss confirm dialog first)
 *   4. Double-tap-to-exit toast at root
 *
 * Usage:
 *   const { registerBackHandler, unregisterBackHandler, isAtRoot } = useHardwareBack();
 *
 *   // A sheet registers itself:
 *   useEffect(() => {
 *     registerBackHandler(() => { closeSheet(); return true; }, 'sheet');
 *     return () => unregisterBackHandler('sheet');
 *   }, []);
 *
 * Callbacks return true to consume the event (stop propagation), false to pass
 * to the next handler in the stack.
 */

import { useEffect, useRef, useCallback, useState } from 'react';

export type BackHandlerFn = () => boolean; // return true = consumed
export type BackHandlerId = string;

interface BackHandlerEntry {
  id: BackHandlerId;
  handler: BackHandlerFn;
}

const ROOT_EXIT_DELAY_MS = 2000; // double-tap window

export function useHardwareBack() {
  const stack = useRef<BackHandlerEntry[]>([]);
  const [isAtRoot, setIsAtRoot] = useState(true);

  // Track double-tap-to-exit
  const lastBackTap = useRef<number>(0);
  const exitToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const registerBackHandler = useCallback(
    (handler: BackHandlerFn, id: BackHandlerId) => {
      // Remove any existing entry with the same id, then push to top
      stack.current = stack.current.filter((e) => e.id !== id);
      stack.current.push({ id, handler });
    },
    []
  );

  const unregisterBackHandler = useCallback((id: BackHandlerId) => {
    stack.current = stack.current.filter((e) => e.id !== id);
  }, []);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      // Walk stack in reverse (LIFO — last registered = highest priority)
      for (let i = stack.current.length - 1; i >= 0; i--) {
        const entry = stack.current[i];
        const consumed = entry.handler();
        if (consumed) {
          // Prevent default back navigation — handler took care of it
          e.preventDefault();
          // Push a dummy state so the browser doesn't actually navigate away
          window.history.pushState(null, '', window.location.href);
          return;
        }
      }

      // No handler consumed the event — we're at root
      setIsAtRoot(true);

      // Double-tap-to-exit pattern
      const now = Date.now();
      if (now - lastBackTap.current < ROOT_EXIT_DELAY_MS) {
        // Second tap within window → allow actual back navigation
        // Clear the toast if showing
        if (exitToastTimer.current) {
          clearTimeout(exitToastTimer.current);
          exitToastTimer.current = null;
        }
        // Let the popstate proceed naturally (don't prevent it)
        return;
      }

      // First tap at root: prevent navigation and show toast
      e.preventDefault();
      window.history.pushState(null, '', window.location.href);
      lastBackTap.current = now;

      // Dispatch a custom event so the UI layer can show a toast
      window.dispatchEvent(
        new CustomEvent('cdz:double-tap-exit', {
          detail: { message: 'Appuyez à nouveau pour quitter' },
        })
      );

      // Reset the double-tap window after timeout
      if (exitToastTimer.current) clearTimeout(exitToastTimer.current);
      exitToastTimer.current = setTimeout(() => {
        lastBackTap.current = 0;
      }, ROOT_EXIT_DELAY_MS);
    };

    // Push initial state so we can intercept
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      if (exitToastTimer.current) clearTimeout(exitToastTimer.current);
    };
  }, []);

  // Recompute isAtRoot when stack changes (no handler registered = at root)
  const checkAtRoot = useCallback(() => {
    setIsAtRoot(stack.current.length === 0);
  }, []);

  // Wrap register/unregister to also update isAtRoot
  const wrappedRegister = useCallback(
    (handler: BackHandlerFn, id: BackHandlerId) => {
      registerBackHandler(handler, id);
      setIsAtRoot(false);
    },
    [registerBackHandler]
  );

  const wrappedUnregister = useCallback(
    (id: BackHandlerId) => {
      unregisterBackHandler(id);
      // Check after a microtask so stack.current is updated
      queueMicrotask(() => {
        setIsAtRoot(stack.current.length === 0);
      });
    },
    [unregisterBackHandler]
  );

  return {
    registerBackHandler: wrappedRegister,
    unregisterBackHandler: wrappedUnregister,
    isAtRoot,
  };
}
