'use client';

import { useEffect, useState } from 'react';

interface Props {
  progress: number;
  loaded: boolean;
  onReady: () => void;
}

/**
 * Phase 1 – Loading: black bg, logo + progress bar
 * Phase 2 – Reveal:  bg fades to transparent over 0.8s, logo stays (game visible behind)
 * Phase 3 – Logo:    logo visible with transparent bg for 2s
 * Phase 4 – Dismiss: logo fades out over 0.6s, then onReady() fires
 */
export default function LoadingScreen({ progress, loaded, onReady }: Props) {
  const [phase, setPhase] = useState<'loading' | 'reveal' | 'logo' | 'dismiss'>('loading');

  useEffect(() => {
    if (!loaded || phase !== 'loading') return;
    // Start reveal as soon as assets are loaded
    setPhase('reveal');
  }, [loaded, phase]);

  useEffect(() => {
    if (phase === 'reveal') {
      // After bg fade (0.8s), enter logo-only phase
      const t = setTimeout(() => setPhase('logo'), 800);
      return () => clearTimeout(t);
    }
    if (phase === 'logo') {
      // Show logo for 2s, then dismiss
      const t = setTimeout(() => setPhase('dismiss'), 2000);
      return () => clearTimeout(t);
    }
    if (phase === 'dismiss') {
      // After fade-out (0.6s), notify parent
      const t = setTimeout(onReady, 600);
      return () => clearTimeout(t);
    }
  }, [phase, onReady]);

  const bgOpacity = phase === 'loading' ? 1 : 0;
  const logoOpacity = phase === 'dismiss' ? 0 : 1;
  const barVisible = phase === 'loading';
  const gone = phase === 'dismiss' && false; // keep mounted until onReady fires

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
        zIndex: 20,
        pointerEvents: phase === 'dismiss' ? 'none' : 'auto',
      }}
    >
      {/* Background layer */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: '#000',
          opacity: bgOpacity,
          transition: 'opacity 0.8s ease-out',
        }}
      />

      {/* Logo */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.jpeg"
        alt="Logo"
        style={{
          position: 'relative',
          width: '60%',
          maxHeight: '70vh',
          objectFit: 'contain',
          opacity: logoOpacity,
          transition: 'opacity 0.6s ease-out',
        }}
        className="splash-logo"
      />

      {/* Progress bar */}
      <div
        style={{
          position: 'relative',
          width: 260,
          height: 4,
          background: 'rgba(255,255,255,0.15)',
          borderRadius: 2,
          overflow: 'hidden',
          opacity: barVisible ? 1 : 0,
          transition: 'opacity 0.4s',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            background: '#e2e8f0',
            borderRadius: 2,
            transition: 'width 0.2s',
          }}
        />
      </div>

      <style>{`
        @media (max-width: 768px) {
          .splash-logo {
            width: 80% !important;
          }
        }
      `}</style>
    </div>
  );
}
