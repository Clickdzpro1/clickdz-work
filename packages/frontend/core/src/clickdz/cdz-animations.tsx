// CDZ Premium AI Animations — smooth loading + streaming output
// Replaces the basic CSS border spinner with premium quality animations.
// Used across Hermes, Agents, and all AI chat surfaces.

import { type CSSProperties, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Premium Loading Indicator — 3-dot pulsing animation with smooth easing
// ---------------------------------------------------------------------------
export const CdzAILoading = ({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) => {
  const dims = { sm: 6, md: 8, lg: 12 }[size];
  const gap = { sm: 3, md: 4, lg: 6 }[size];
  
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap }} role="status" aria-label="AI thinking">
      <style>{`
        @keyframes cdz-ai-pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: dims,
          height: dims,
          borderRadius: '50%',
          background: 'var(--affine-primary-color, #1e96eb)',
          animation: `cdz-ai-pulse 1.4s ease-in-out ${i * 0.16}s infinite`,
          display: 'inline-block',
        }} />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Premium Spinner — smooth gradient ring with conic gradient
// ---------------------------------------------------------------------------
export const CdzSpinner = ({ size = 16 }: { size?: number }) => (
  <span style={{
    display: 'inline-block',
    width: size,
    height: size,
    borderRadius: '50%',
    background: `conic-gradient(from 0deg, transparent 0%, var(--affine-primary-color, #1e96eb) 100%)`,
    animation: 'cdz-spin-smooth 0.8s cubic-bezier(0.4, 0, 0.2, 1) infinite',
    mask: `radial-gradient(circle at center, transparent ${size/3}px, black ${size/3 + 1}px)`,
    WebkitMask: `radial-gradient(circle at center, transparent ${size/3}px, black ${size/3 + 1}px)`,
  }}>
    <style>{'@keyframes cdz-spin-smooth{to{transform:rotate(360deg)}}'}</style>
  </span>
);

// ---------------------------------------------------------------------------
// Streaming Text — smooth character-by-character reveal with fade-in
// ---------------------------------------------------------------------------
export const CdzStreamingText = ({ text, speed = 15 }: { text: string; speed?: number }) => {
  const [displayed, setDisplayed] = useState('');
  const [isStreaming, setIsStreaming] = useState(true);
  const idxRef = useRef(0);
  
  useEffect(() => {
    if (text === displayed) {
      setIsStreaming(false);
      return;
    }
    
    // If text grew (new chunk arrived), stream the new part
    if (text.startsWith(displayed)) {
      const remaining = text.slice(displayed.length);
      let localIdx = 0;
      
      const interval = setInterval(() => {
        if (localIdx >= remaining.length) {
          clearInterval(interval);
          setIsStreaming(false);
          return;
        }
        // Stream 1-3 chars per tick for natural feel
        const chunk = Math.min(3, remaining.length - localIdx);
        setDisplayed(prev => prev + remaining.slice(localIdx, localIdx + chunk));
        localIdx += chunk;
      }, speed);
      
      return () => clearInterval(interval);
    } else {
      // Text changed completely — reset
      setDisplayed(text);
      setIsStreaming(false);
    }
  }, [text, speed]);
  
  return (
    <span style={{
      position: 'relative',
      animation: isStreaming ? 'cdz-text-fade-in 0.3s ease-out' : 'none',
    }}>
      {displayed}
      {isStreaming && (
        <span style={{
          display: 'inline-block',
          width: 2,
          height: '1em',
          marginLeft: 2,
          background: 'var(--affine-primary-color, #1e96eb)',
          animation: 'cdz-cursor-blink 0.8s steps(2) infinite',
          verticalAlign: 'text-bottom',
        }} />
      )}
      <style>{`
        @keyframes cdz-text-fade-in {
          from { opacity: 0.6; }
          to { opacity: 1; }
        }
        @keyframes cdz-cursor-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </span>
  );
};

// ---------------------------------------------------------------------------
// Message Bubble — fade-in + slide-up entrance for new messages
// ---------------------------------------------------------------------------
export const CdzMessageBubble = ({ children, isUser }: { children: React.ReactNode; isUser?: boolean }) => (
  <div style={{
    animation: `cdz-msg-enter 0.35s cubic-bezier(0.16, 1, 0.3, 1)`,
    transformOrigin: 'bottom',
  }}>
    {children}
    <style>{`
      @keyframes cdz-msg-enter {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.98);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
    `}</style>
  </div>
);

// ---------------------------------------------------------------------------
// Typing Indicator — premium "AI is thinking" with wave animation
// ---------------------------------------------------------------------------
export const CdzTypingIndicator = () => (
  <div style={{
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '8px 12px',
    borderRadius: 12,
    background: 'var(--affine-background-secondary-color, #1c1c1e)',
    border: '1px solid var(--affine-border-color, #2a2a2c)',
  }}>
    <style>{`
      @keyframes cdz-wave {
        0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
        30% { transform: translateY(-4px); opacity: 1; }
      }
    `}</style>
    {[0, 1, 2].map(i => (
      <span key={i} style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--affine-primary-color, #1e96eb)',
        animation: `cdz-wave 1.2s ease-in-out ${i * 0.15}s infinite`,
        display: 'inline-block',
      }} />
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Shimmer Skeleton — for loading content placeholders
// ---------------------------------------------------------------------------
export const CdzShimmer = ({ width = '100%', height = 20, radius = 6 }: { width?: string | number; height?: number; radius?: number }) => (
  <div style={{
    width,
    height,
    borderRadius: radius,
    background: 'linear-gradient(90deg, var(--affine-background-secondary-color, #1c1c1e) 25%, var(--affine-background-tertiary-color, #232326) 50%, var(--affine-background-secondary-color, #1c1c1e) 75%)',
    backgroundSize: '200% 100%',
    animation: 'cdz-shimmer 1.5s ease-in-out infinite',
  }}>
    <style>{`
      @keyframes cdz-shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `}</style>
  </div>
);

// ---------------------------------------------------------------------------
// Streaming Code Block — syntax-highlighted code with line-by-line reveal
// ---------------------------------------------------------------------------
export const CdzStreamingCode = ({ code }: { code: string }) => {
  const [visibleLines, setVisibleLines] = useState(0);
  const lines = code.split('\n');
  
  useEffect(() => {
    if (visibleLines >= lines.length) return;
    const timer = setTimeout(() => {
      setVisibleLines(prev => Math.min(prev + 1, lines.length));
    }, 50);
    return () => clearTimeout(timer);
  }, [visibleLines, lines.length]);
  
  return (
    <pre style={{
      margin: 0,
      padding: '12px 14px',
      borderRadius: 8,
      background: 'var(--affine-background-secondary-color, #1c1c1e)',
      border: '1px solid var(--affine-border-color, #2a2a2c)',
      overflow: 'auto',
      fontFamily: 'var(--affine-font-code-family, monospace)',
      fontSize: 13,
      lineHeight: 1.6,
      color: 'var(--affine-text-primary-color, #ececec)',
    }}>
      <code>
        {lines.slice(0, visibleLines).join('\n')}
        {visibleLines < lines.length && (
          <span style={{
            display: 'inline-block',
            width: 7,
            height: 14,
            marginLeft: 2,
            background: 'var(--affine-primary-color, #1e96eb)',
            animation: 'cdz-cursor-blink 0.8s steps(2) infinite',
            verticalAlign: 'text-bottom',
          }}>
            <style>{'@keyframes cdz-cursor-blink{0%,100%{opacity:1}50%{opacity:0}}'}</style>
          </span>
        )}
      </code>
    </pre>
  );
};
