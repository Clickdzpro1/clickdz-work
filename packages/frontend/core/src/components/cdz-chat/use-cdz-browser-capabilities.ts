/**
 * Browser-capability detection for the CDZ sidechat voice features.
 *
 * The ai-chat-input sidechat uses getUserMedia + AudioContext (waveform) +
 * SpeechRecognition (live transcription). SpeechRecognition is unreliable on
 * iOS Safari and unavailable on Firefox, so we hide the mic button there
 * rather than expose a broken experience. Detection runs once on mount and the
 * result is cached.
 *
 * Privacy: audio is transcribed by the browser vendor's cloud service during
 * active listening (inherent to the Web Speech API on Chrome/Edge). No audio
 * or transcript reaches work.clickdz.ai servers until the user submits.
 */
import { useMemo } from 'react';

export interface CdzBrowserCapabilities {
  hasGetUserMedia: boolean;
  hasAudioContext: boolean;
  hasSpeechRecognition: boolean;
  isIOS: boolean;
  isSafari: boolean;
  isFirefox: boolean;
  /** Final decision: should the mic button be rendered? */
  micButtonVisible: boolean;
}

function detect(): CdzBrowserCapabilities {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    // SSR / non-browser — assume no capabilities.
    return {
      hasGetUserMedia: false,
      hasAudioContext: false,
      hasSpeechRecognition: false,
      isIOS: false,
      isSafari: false,
      isFirefox: false,
      micButtonVisible: false,
    };
  }

  const hasGetUserMedia = !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );

  const hasAudioContext = !!(
    window.AudioContext || (window as any).webkitAudioContext
  );

  const SpeechRecognitionAPI =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;
  const hasSpeechRecognition = !!SpeechRecognitionAPI;

  const ua = navigator.userAgent || '';
  // iPad on iOS 13+ reports as MacIntel with touch points.
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  const isFirefox = /firefox|fxios/i.test(ua);

  // Show the mic button only where SpeechRecognition is both available AND
  // reliable. iOS Safari / Chrome-on-iOS: API exists but is bug-ridden -> HIDE.
  // Firefox: API behind a flag, effectively unavailable -> HIDE.
  const micButtonVisible =
    hasSpeechRecognition && hasGetUserMedia && !isIOS && !isFirefox;

  return {
    hasGetUserMedia,
    hasAudioContext,
    hasSpeechRecognition,
    isIOS,
    isSafari,
    isFirefox,
    micButtonVisible,
  };
}

/**
 * Detect browser capabilities once and memoize. Safe to call during SSR
 * (returns an all-false object).
 */
export function useCdzBrowserCapabilities(): CdzBrowserCapabilities {
  return useMemo(detect, []);
}
