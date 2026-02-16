import { Camera, EventDispatcher } from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import type { InputState } from './InputState';

export class FirstPersonControls extends EventDispatcher {
  private controls: PointerLockControls;
  private inputState: InputState;
  private canvas: HTMLCanvasElement;
  private pressedKeys = new Set<string>();

  private onKeyDown = (event: KeyboardEvent) => {
    this.pressedKeys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.pressedKeys.delete(event.code);
  };

  private onLock = () => {
    this.inputState.pointerLocked = true;
  };

  private onUnlock = () => {
    this.inputState.pointerLocked = false;
  };

  private onClick = () => {
    this.controls.lock();
  };

  constructor(camera: Camera, canvas: HTMLCanvasElement, inputState: InputState) {
    super();
    this.canvas = canvas;
    this.inputState = inputState;
    this.controls = new PointerLockControls(camera, canvas);

    this.controls.addEventListener('lock', this.onLock);
    this.controls.addEventListener('unlock', this.onUnlock);

    this.canvas.addEventListener('click', this.onClick);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
  }

  update(): void {
    let moveForward = 0;
    let moveSide = 0;

    // Forward/backward
    if (this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp')) {
      moveForward += 1;
    }
    if (this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown')) {
      moveForward -= 1;
    }

    // Left/right
    if (this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft')) {
      moveSide -= 1;
    }
    if (this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight')) {
      moveSide += 1;
    }

    this.inputState.moveForward = moveForward;
    this.inputState.moveSide = moveSide;
  }

  dispose(): void {
    this.controls.removeEventListener('lock', this.onLock);
    this.controls.removeEventListener('unlock', this.onUnlock);
    this.canvas.removeEventListener('click', this.onClick);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    this.controls.dispose();
  }
}
