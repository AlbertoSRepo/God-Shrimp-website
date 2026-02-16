'use client';

interface Props {
  progress: number;
  visible: boolean;
}

export default function LoadingScreen({ progress, visible }: Props) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1a1a2e',
        zIndex: 10,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 0.5s',
      }}
    >
      <div
        style={{
          width: 260,
          height: 4,
          background: 'rgba(255,255,255,0.1)',
          borderRadius: 2,
          overflow: 'hidden',
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
    </div>
  );
}
