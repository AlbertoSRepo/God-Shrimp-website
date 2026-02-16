import * as THREE from 'three';
import type { InputState } from './InputState';

export class MobileInputManager {
  private camera: THREE.Camera;
  private inputState: InputState;
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(camera: THREE.Camera, inputState: InputState) {
    this.camera = camera;
    this.inputState = inputState;
  }

  handleLook(dx: number, dy: number): void {
    // Apply camera rotation from joystick
    // dx/dy are continuous values from nipplejs (-3..3 roughly)
    // Apply to euler.y (yaw) and euler.x (pitch)
    // Clamp pitch to -PI/2..PI/2
    this.euler.setFromQuaternion(this.camera.quaternion);
    this.euler.y -= dx * 0.02;
    this.euler.x -= dy * 0.02;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
    this.camera.quaternion.setFromEuler(this.euler);
  }

  handleMove(dx: number, dy: number): void {
    // Write movement to input state
    // dx = left/right (-1..1), dy = forward/backward (-1..1)
    this.inputState.moveForward = dy;
    this.inputState.moveSide = dx;
  }

  dispose(): void {}
}
