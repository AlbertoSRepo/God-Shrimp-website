'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import LoadingScreen from '@/components/LoadingScreen';
import FullscreenPrompt from '@/components/FullscreenPrompt';

const MobileControls = dynamic(() => import('@/components/MobileControls'), {
  ssr: false,
});

export default function Home() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<any>(null);
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const [showFullscreenPrompt, setShowFullscreenPrompt] = useState(false);

  // Mobile detection - runs once, sets isMobile to true/false
  useEffect(() => {
    const check =
      /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      ) ||
      ('ontouchstart' in window && window.innerWidth < 1024);
    setIsMobile(check);
  }, []);

  // Show fullscreen prompt when loaded on mobile
  useEffect(() => {
    if (loaded && isMobile) {
      setShowFullscreenPrompt(true);
    }
  }, [loaded, isMobile]);

  // Engine lifecycle - wait until mobile detection is done (isMobile !== null)
  useEffect(() => {
    if (!containerRef.current || isMobile === null) return;

    let engine: any = null;

    import('@/lib/SceneEngine').then(({ SceneEngine }) => {
      if (!containerRef.current) return;
      engine = new SceneEngine(containerRef.current, {
        isMobile,
        onProgress: (pct: number) => setProgress(pct),
        onLoaded: () => setLoaded(true),
      });
      engineRef.current = engine;
      engine.init();
    });

    return () => {
      if (engine) {
        engine.dispose();
      }
      engineRef.current = null;
    };
  }, [isMobile]);

  const handleMove = useCallback((dx: number, dy: number) => {
    engineRef.current?.handleMobileMove(dx, dy);
  }, []);

  const handleLook = useCallback((dx: number, dy: number) => {
    engineRef.current?.handleMobileLook(dx, dy);
  }, []);

  return (
    <>
      <div ref={containerRef} style={{ width: '100vw', height: '100vh' }} />
      <LoadingScreen progress={progress} visible={!loaded} />
      {isMobile === true && loaded && (
        <MobileControls onMove={handleMove} onLook={handleLook} />
      )}
      {showFullscreenPrompt && (
        <FullscreenPrompt onDismiss={() => setShowFullscreenPrompt(false)} />
      )}
    </>
  );
}
