'use client';

import { useEffect, useRef } from 'react';
import nipplejs, { type JoystickOutputData } from 'nipplejs';

interface MobileControlsProps {
  onLook: (dx: number, dy: number) => void;
  onMove: (dx: number, dy: number) => void;
}

export default function MobileControls({ onLook, onMove }: MobileControlsProps) {
  const lookZoneRef = useRef<HTMLDivElement>(null);
  const moveZoneRef = useRef<HTMLDivElement>(null);
  const onMoveRef = useRef(onMove);
  const onLookRef = useRef(onLook);
  onMoveRef.current = onMove;
  onLookRef.current = onLook;

  // Left joystick: camera look
  useEffect(() => {
    if (!lookZoneRef.current) return;

    const manager = nipplejs.create({
      zone: lookZoneRef.current,
      mode: 'static',
      position: { left: '80px', bottom: '100px' },
      color: 'rgba(255, 255, 255, 0.5)',
      size: 120,
    });

    manager.on('move', (_evt: any, data: JoystickOutputData) => {
      const force = Math.min(data.force, 2) / 2;
      const angle = data.angle.radian;
      const dx = Math.cos(angle) * force * 3;
      const dy = -Math.sin(angle) * force * 3;
      onLookRef.current(dx, dy);
    });

    manager.on('end', () => {
      onLookRef.current(0, 0);
    });

    return () => {
      manager.destroy();
    };
  }, []);

  // Right joystick: movement
  useEffect(() => {
    if (!moveZoneRef.current) return;

    const manager = nipplejs.create({
      zone: moveZoneRef.current,
      mode: 'static',
      position: { right: '80px', bottom: '100px' },
      color: 'rgba(255, 255, 255, 0.5)',
      size: 120,
    });

    manager.on('move', (_evt: any, data: JoystickOutputData) => {
      const force = Math.min(data.force, 2) / 2;
      const angle = data.angle.radian;
      // Forward/backward = Y component, strafe = X component
      const dx = Math.cos(angle) * force;
      const dy = Math.sin(angle) * force;
      onMoveRef.current(dx, dy);
    });

    manager.on('end', () => {
      onMoveRef.current(0, 0);
    });

    return () => {
      manager.destroy();
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      {/* Left: look joystick zone */}
      <div
        ref={lookZoneRef}
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: '50%',
          height: '40%',
          pointerEvents: 'auto',
        }}
      />

      {/* Right: move joystick zone */}
      <div
        ref={moveZoneRef}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: '50%',
          height: '40%',
          pointerEvents: 'auto',
        }}
      />
    </div>
  );
}
