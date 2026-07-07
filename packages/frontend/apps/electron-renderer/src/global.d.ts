import type { apis, events } from '@ClickDz Work/electron-api';

/**
 * Extends the global Window interface to include ClickDz Work's 
 * Electron bridge APIs and event emitters.
 */
declare global {
  interface Window {
    __apis?: {
      apis: typeof apis;
      events: typeof events;
    };
  }
}

export {};
