import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

interface NPCState {
  npc: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  isAware: boolean;
  awareTimer: number;
  idleAction: THREE.AnimationAction | null;
  awareAction: THREE.AnimationAction | null;
  originalQuaternion: THREE.Quaternion;
  targetQuaternion: THREE.Quaternion;
  currentRotationProgress: number;
  cooldownTimer: number;
}

export class NPCManager {
  private npcStates: NPCState[] = [];
  private statuePosition: THREE.Vector3 | null = null;

  // Configuration from environment variables
  private readonly idleAnimationName: string;
  private readonly awareAnimationName: string;
  private readonly heightOffset: number;
  private readonly awarenessDistance: number;
  private readonly awarenessAngle: number;
  private readonly awarenessDuration: number;
  private readonly cooldownDuration: number;

  // Reusable vectors for calculations
  private readonly _npcToCamera = new THREE.Vector3();
  private readonly _npcForward = new THREE.Vector3();
  private readonly _tempQuaternion = new THREE.Quaternion();

  constructor() {
    // Load configuration from environment variables with defaults
    this.idleAnimationName = process.env.NEXT_PUBLIC_NPC_ANIMATION || 'Jazz_Hands_inplace';
    this.awareAnimationName = process.env.NEXT_PUBLIC_NPC_AWARE_ANIMATION || 'Running';
    this.heightOffset = parseFloat(process.env.NEXT_PUBLIC_NPC_HEIGHT_OFFSET || '-0.3');
    this.awarenessDistance = parseFloat(process.env.NEXT_PUBLIC_NPC_AWARENESS_DISTANCE || '8');
    this.awarenessAngle = parseFloat(process.env.NEXT_PUBLIC_NPC_AWARENESS_ANGLE || '180');
    this.awarenessDuration = parseFloat(process.env.NEXT_PUBLIC_NPC_AWARENESS_DURATION || '6');
    this.cooldownDuration = parseFloat(process.env.NEXT_PUBLIC_NPC_AWARENESS_COOLDOWN || '30');
  }

  async init(sceneModel: THREE.Group, threeScene: THREE.Scene): Promise<void> {
    // Find the Shrimp_god_statue to make NPCs look at it
    sceneModel.traverse((node) => {
      if (node.name === 'Shrimp_god_statue') {
        this.statuePosition = new THREE.Vector3();
        node.getWorldPosition(this.statuePosition);
      }
    });

    // Find all Shrimp*_position spawn points
    const spawnPoints: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; name: string }> = [];

    sceneModel.traverse((node) => {
      if (node.name.match(/^Shrimp\d+_position$/)) {
        const worldPosition = new THREE.Vector3();
        const worldQuaternion = new THREE.Quaternion();
        node.getWorldPosition(worldPosition);
        node.getWorldQuaternion(worldQuaternion);

        spawnPoints.push({
          position: worldPosition,
          quaternion: worldQuaternion,
          name: node.name
        });
      }
    });

    // Sort spawn points by name to ensure consistent animation assignment
    spawnPoints.sort((a, b) => a.name.localeCompare(b.name));

    if (spawnPoints.length === 0) {
      console.warn('No Shrimp spawn points found in scene');
      return;
    }

    // Load the shrimp character model
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync('/models/Shrimp_Animations.glb');

    const animations = gltf.animations;

    // Create an NPC at each spawn point
    for (const spawnPoint of spawnPoints) {
      // Clone the character using SkeletonUtils for skeletal animations
      const npcClone = SkeletonUtils.clone(gltf.scene);

      // Set position from spawn point and apply height offset
      npcClone.position.copy(spawnPoint.position);
      npcClone.position.y += this.heightOffset;

      // Store the original quaternion facing the statue
      const originalQuaternion = new THREE.Quaternion();
      if (this.statuePosition) {
        npcClone.lookAt(this.statuePosition);
        originalQuaternion.copy(npcClone.quaternion);
      } else {
        // Fallback to spawn point rotation if statue not found
        originalQuaternion.copy(spawnPoint.quaternion);
        npcClone.quaternion.copy(spawnPoint.quaternion);
      }

      // Enable shadows on all meshes
      npcClone.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      // Add to scene
      threeScene.add(npcClone);

      // Create animation mixer
      const mixer = new THREE.AnimationMixer(npcClone);

      // Find and prepare animations
      const idleAnimation = animations.find((clip) => clip.name === this.idleAnimationName);
      const awareAnimation = animations.find((clip) => clip.name === this.awareAnimationName);

      let idleAction: THREE.AnimationAction | null = null;
      let awareAction: THREE.AnimationAction | null = null;

      if (idleAnimation) {
        idleAction = mixer.clipAction(idleAnimation);
        idleAction.play();
      } else {
        console.warn(`Idle animation ${this.idleAnimationName} not found for NPC at ${spawnPoint.name}`);
      }

      if (awareAnimation) {
        awareAction = mixer.clipAction(awareAnimation);
        awareAction.setEffectiveWeight(0);
        awareAction.play();
      } else {
        console.warn(`Aware animation ${this.awareAnimationName} not found for NPC at ${spawnPoint.name}`);
      }

      // Create NPC state
      const npcState: NPCState = {
        npc: npcClone,
        mixer: mixer,
        isAware: false,
        awareTimer: 0,
        idleAction: idleAction,
        awareAction: awareAction,
        originalQuaternion: originalQuaternion.clone(),
        targetQuaternion: new THREE.Quaternion(),
        currentRotationProgress: 1.0, // 1.0 = fully at original rotation
        cooldownTimer: 0
      };

      this.npcStates.push(npcState);
    }

    console.log(`Initialized ${this.npcStates.length} NPCs with awareness system`);
    console.log(`Configuration: idle=${this.idleAnimationName}, aware=${this.awareAnimationName}, distance=${this.awarenessDistance}, angle=${this.awarenessAngle}, duration=${this.awarenessDuration}s, cooldown=${this.cooldownDuration}s`);
  }

  update(delta: number, cameraPosition: THREE.Vector3): void {
    const halfAwarenessAngle = (this.awarenessAngle * Math.PI) / 360; // Convert to radians and half

    for (const state of this.npcStates) {
      // Update animation mixer
      state.mixer.update(delta);

      // Decrement cooldown timer
      if (state.cooldownTimer > 0) {
        state.cooldownTimer -= delta;
      }

      // Calculate direction from NPC to camera
      this._npcToCamera.subVectors(cameraPosition, state.npc.position);
      this._npcToCamera.y = 0; // Ignore vertical component
      const distanceToCamera = this._npcToCamera.length();
      this._npcToCamera.normalize();

      // Calculate NPC's forward direction (local -Z axis = lookAt direction)
      this._npcForward.set(0, 0, -1);
      this._npcForward.applyQuaternion(state.npc.quaternion);
      this._npcForward.y = 0;
      this._npcForward.normalize();

      // Calculate angle between NPC forward and direction to camera
      const dotProduct = this._npcForward.dot(this._npcToCamera);
      const angleToCamera = Math.acos(Math.max(-1, Math.min(1, dotProduct)));

      // Check if player is within awareness field of view and distance (skip if on cooldown)
      const inFOV = angleToCamera < halfAwarenessAngle;
      const inRange = distanceToCamera < this.awarenessDistance;
      const offCooldown = state.cooldownTimer <= 0;
      const playerDetected = inFOV && inRange && offCooldown;

      // Debug log every ~60 frames (throttled to avoid spam)
      const npcIndex = this.npcStates.indexOf(state);
      if (npcIndex === 0 && Math.random() < 0.02) {
        const angleDeg = (angleToCamera * 180 / Math.PI).toFixed(1);
        const halfAngleDeg = (halfAwarenessAngle * 180 / Math.PI).toFixed(1);
        console.log(`[NPC#${npcIndex}] dist=${distanceToCamera.toFixed(2)} (max=${this.awarenessDistance}), angle=${angleDeg}° (max=${halfAngleDeg}°), inFOV=${inFOV}, inRange=${inRange}, offCooldown=${offCooldown}, cooldown=${state.cooldownTimer.toFixed(1)}s, isAware=${state.isAware}`);
      }

      if (playerDetected && !state.isAware) {
        // Player just entered awareness zone
        state.isAware = true;
        state.awareTimer = 0;
        console.log(`[NPC#${npcIndex}] DETECTED player! dist=${distanceToCamera.toFixed(2)}, angle=${(angleToCamera * 180 / Math.PI).toFixed(1)}°`);

        // Immediately stop idle animation (freeze in place)
        if (state.idleAction) {
          state.idleAction.paused = true;
        }

        // Calculate target quaternion to face player
        const tempObj = new THREE.Object3D();
        tempObj.position.copy(state.npc.position);
        tempObj.lookAt(cameraPosition.x, state.npc.position.y, cameraPosition.z);
        state.targetQuaternion.copy(tempObj.quaternion);
        state.currentRotationProgress = 0;
      }

      if (state.isAware) {
        // Update aware timer
        state.awareTimer += delta;

        // Continuously track player position
        const tempObj = new THREE.Object3D();
        tempObj.position.copy(state.npc.position);
        tempObj.lookAt(cameraPosition.x, state.npc.position.y, cameraPosition.z);
        state.targetQuaternion.copy(tempObj.quaternion);

        // Smoothly rotate toward player
        state.npc.quaternion.slerp(state.targetQuaternion, delta * 5.0);

        // Check if awareness duration has expired
        if (state.awareTimer >= this.awarenessDuration) {
          // Return to idle state
          state.isAware = false;
          state.awareTimer = 0;
          state.cooldownTimer = this.cooldownDuration;
          console.log(`[NPC#${npcIndex}] Awareness expired, returning to idle. Cooldown=${this.cooldownDuration}s`);

          // Resume idle animation
          if (state.idleAction) {
            state.idleAction.paused = false;
          }

          // Set target to rotate back to original position (facing statue)
          state.targetQuaternion.copy(state.originalQuaternion);
          state.currentRotationProgress = 0;
        }
      } else if (state.currentRotationProgress < 1.0) {
        // Not aware, but still rotating back to original position
        state.currentRotationProgress = Math.min(1.0, state.currentRotationProgress + delta * 1.5);
        state.npc.quaternion.slerpQuaternions(
          state.npc.quaternion,
          state.targetQuaternion,
          delta * 2.0
        );
      }
    }
  }

  getNPCs(): THREE.Object3D[] {
    return this.npcStates.map(state => state.npc);
  }

  dispose(): void {
    // Stop all mixers
    this.npcStates.forEach((state) => {
      state.mixer.stopAllAction();
    });

    // Remove NPCs from scene
    this.npcStates.forEach((state) => {
      if (state.npc.parent) {
        state.npc.parent.remove(state.npc);
      }
    });

    // Clear arrays
    this.npcStates = [];
  }
}
