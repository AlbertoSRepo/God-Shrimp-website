'use client';

import { useState, useEffect } from 'react';

interface FullscreenPromptProps {
  onDismiss: () => void;
}

export default function FullscreenPrompt({ onDismiss }: FullscreenPromptProps) {
  const [visible, setVisible] = useState(true);

  const enterFullscreen = async () => {
    try {
      const docEl = document.documentElement as any;

      // Request fullscreen with vendor prefixes
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.mozRequestFullScreen) {
        await docEl.mozRequestFullScreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }

      // Try to lock orientation to landscape
      try {
        if (screen.orientation && (screen.orientation as any).lock) {
          await (screen.orientation as any).lock('landscape');
          console.log('Screen orientation locked to landscape');
        }
      } catch (orientationError) {
        console.warn('Could not lock screen orientation:', orientationError);
      }

      console.log('Fullscreen mode activated');
    } catch (error) {
      console.error('Failed to enter fullscreen:', error);
    } finally {
      setVisible(false);
      onDismiss();
    }
  };

  const dismiss = () => {
    setVisible(false);
    onDismiss();
  };

  useEffect(() => {
    // Listen for fullscreen changes in case user exits
    const handleFullscreenChange = () => {
      const isFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );

      if (!isFullscreen && visible) {
        // User exited fullscreen, dismiss the prompt
        setVisible(false);
        onDismiss();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, [visible, onDismiss]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        zIndex: 9999,
        gap: '20px',
      }}
    >
      <div
        style={{
          color: 'white',
          fontSize: '24px',
          fontWeight: 'bold',
          textAlign: 'center',
          marginBottom: '10px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        For the best experience
      </div>
      <div
        style={{
          color: 'rgba(255, 255, 255, 0.8)',
          fontSize: '16px',
          textAlign: 'center',
          marginBottom: '20px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        Play in fullscreen landscape mode
      </div>
      <button
        onClick={enterFullscreen}
        style={{
          padding: '16px 40px',
          fontSize: '18px',
          fontWeight: 'bold',
          color: 'white',
          backgroundColor: 'rgba(255, 255, 255, 0.15)',
          border: '2px solid rgba(255, 255, 255, 0.3)',
          borderRadius: '12px',
          cursor: 'pointer',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          transition: 'all 0.2s ease',
        }}
        onMouseDown={(e) => {
          e.currentTarget.style.transform = 'scale(0.95)';
        }}
        onMouseUp={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
        }}
        onTouchStart={(e) => {
          e.currentTarget.style.transform = 'scale(0.95)';
        }}
        onTouchEnd={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
        }}
      >
        Enter Fullscreen
      </button>
      <button
        onClick={dismiss}
        style={{
          padding: '12px 30px',
          fontSize: '14px',
          color: 'rgba(255, 255, 255, 0.6)',
          backgroundColor: 'transparent',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          borderRadius: '8px',
          cursor: 'pointer',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          marginTop: '10px',
        }}
      >
        Continue without fullscreen
      </button>
    </div>
  );
}
