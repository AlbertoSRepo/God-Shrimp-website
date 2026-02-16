export interface InputState {
  moveForward: number;  // -1..1
  moveSide: number;     // -1..1
  lookX: number;        // camera rotation delta
  lookY: number;        // camera rotation delta
  pointerLocked: boolean;
}

export function createInputState(): InputState {
  return {
    moveForward: 0,
    moveSide: 0,
    lookX: 0,
    lookY: 0,
    pointerLocked: false,
  };
}
