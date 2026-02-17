import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { GrassSystem } from './GrassSystem';
import { NPCManager } from './NPCManager';
import { FirstPersonControls } from './FirstPersonControls';
import { MobileInputManager } from './MobileInputManager';
import { createInputState, type InputState } from './InputState';

interface EngineOptions {
  isMobile: boolean;
  onProgress: (pct: number) => void;
  onLoaded: () => void;
}

export class SceneEngine {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private mixer: THREE.AnimationMixer | null = null;
  private grassSystem: GrassSystem;
  private npcManager: NPCManager;
  private fpControls: FirstPersonControls | null = null;
  private mobileInput: MobileInputManager | null = null;
  private inputState: InputState;
  private options: EngineOptions;
  private container: HTMLDivElement;
  private disposed = false;

  // Sky / day-night cycle
  private hdrTexture: THREE.DataTexture | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private _sunPosition = new THREE.Vector3();
  /** Full cycle duration in seconds (default ~150s = 2.5 minutes) */
  private cycleDuration = 150;
  /** Distance for directional light placement */
  private sunDistance = 40;

  // Reusable vectors for movement calculation
  private _direction = new THREE.Vector3();
  private _right = new THREE.Vector3();
  // Reusable colors for day-night cycle (avoid per-frame allocation)
  private _fogColor = new THREE.Color();
  private _dayColor = new THREE.Color(0x87ceeb);

  // Celestial bodies (visible sun)
  private sunModel: THREE.Group | null = null; // loaded from Sun.glb
  private sunMesh: THREE.Mesh | null = null; // kept for dispose compat (null now)
  private sunGlow: THREE.Mesh | null = null;
  private celestialDistance = 400; // how far from origin to place sun

  // Sun orbit reference points (extracted from scene.glb)
  private isleCenter = new THREE.Vector3(0, 0, 0);
  private sunPointY = 200; // zenith height from Sun-point object
  private seaLevel = 0; // Y position of the Sea plane
  private orbitRadius = 300; // computed from sunPointY and isle center
  private visibilityRadius = 150; // from Visibility circle asset in scene.glb

  // Star field
  private starField: THREE.Points | null = null;

  // Volumetric cloud around Sky_city
  private cloudMesh: THREE.Mesh | null = null;
  private cloudMaterial: THREE.RawShaderMaterial | null = null;
  private cloudTexture: THREE.Data3DTexture | null = null;

  // Volumetric fog around Island base
  private islandFogMesh: THREE.Mesh | null = null;
  private islandFogMaterial: THREE.RawShaderMaterial | null = null;
  private islandFogTexture: THREE.Data3DTexture | null = null;

  // Sea cartoon shader
  private seaMaterial: THREE.ShaderMaterial | null = null;
  private seaMesh: THREE.Mesh | null = null;

  // Scene fog (linear fog based on Visibility circle radius)
  private sceneFog: THREE.Fog | null = null;

  // Moonlight: dim fill light at night so assets aren't fully black
  private moonLight: THREE.DirectionalLight | null = null;

  // Statue point light: spherical glow around Shrimp_god_statue at night
  private statueLight: THREE.PointLight | null = null;

  // Sun point light: bright radial light emitted from the Sun model itself
  private sunPointLight: THREE.PointLight | null = null;

  // Spatial audio
  private audioListener: THREE.AudioListener | null = null;
  private positionalAudio: THREE.PositionalAudio | null = null;
  private audioMesh: THREE.Object3D | null = null;
  private audioResumed = false;
  private _initAudioOnGesture: (() => void) | null = null;

  // Ground physics
  private _raycaster = new THREE.Raycaster();
  private _rayOrigin = new THREE.Vector3();
  private _rayDown = new THREE.Vector3(0, -1, 0);
  private _rayForward = new THREE.Vector3();
  private groundMeshes: THREE.Mesh[] = [];
  private playerHeight = 1.6; // eye height above ground
  private gravity = 9.8;
  private verticalVelocity = 0;
  private isGrounded = false;

  // Shared GLSL shaders for volumetric effects
  private volumetricVertexShader = /* glsl */ `
    in vec3 position;

    uniform mat4 modelMatrix;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform vec3 cameraPos;

    out vec3 vOrigin;
    out vec3 vDirection;

    void main() {
      vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );

      vOrigin = vec3( inverse( modelMatrix ) * vec4( cameraPos, 1.0 ) ).xyz;
      vDirection = position - vOrigin;

      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  private volumetricFragmentShader = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;

    in vec3 vOrigin;
    in vec3 vDirection;

    out vec4 color;

    uniform vec3 base;
    uniform sampler3D map;

    uniform float threshold;
    uniform float range;
    uniform float opacity;
    uniform float steps;
    uniform float frame;

    uint wang_hash(uint seed)
    {
      seed = (seed ^ 61u) ^ (seed >> 16u);
      seed *= 9u;
      seed = seed ^ (seed >> 4u);
      seed *= 0x27d4eb2du;
      seed = seed ^ (seed >> 15u);
      return seed;
    }

    float randomFloat(inout uint seed)
    {
      return float(wang_hash(seed)) / 4294967296.;
    }

    vec2 hitBox( vec3 orig, vec3 dir ) {
      const vec3 box_min = vec3( - 0.5 );
      const vec3 box_max = vec3( 0.5 );
      vec3 inv_dir = 1.0 / dir;
      vec3 tmin_tmp = ( box_min - orig ) * inv_dir;
      vec3 tmax_tmp = ( box_max - orig ) * inv_dir;
      vec3 tmin = min( tmin_tmp, tmax_tmp );
      vec3 tmax = max( tmin_tmp, tmax_tmp );
      float t0 = max( tmin.x, max( tmin.y, tmin.z ) );
      float t1 = min( tmax.x, min( tmax.y, tmax.z ) );
      return vec2( t0, t1 );
    }

    float sample1( vec3 p ) {
      return texture( map, p ).r;
    }

    float shading( vec3 coord ) {
      float step = 0.01;
      return sample1( coord + vec3( - step ) ) - sample1( coord + vec3( step ) );
    }

    vec4 linearToSRGB( in vec4 value ) {
      return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
    }

    void main(){
      vec3 rayDir = normalize( vDirection );
      vec2 bounds = hitBox( vOrigin, rayDir );

      if ( bounds.x > bounds.y ) discard;

      bounds.x = max( bounds.x, 0.0 );

      float stepSize = ( bounds.y - bounds.x ) / steps;

      // Jitter
      uint seed = uint( gl_FragCoord.x ) * uint( 1973 ) + uint( gl_FragCoord.y ) * uint( 9277 ) + uint( frame ) * uint( 26699 );
      vec3 size = vec3( textureSize( map, 0 ) );
      float randNum = randomFloat( seed ) * 2.0 - 1.0;
      vec3 p = vOrigin + bounds.x * rayDir;
      p += rayDir * randNum * ( 1.0 / size );

      vec4 ac = vec4( base, 0.0 );

      for ( float i = 0.0; i < steps; i += 1.0 ) {

        float t = bounds.x + i * stepSize;

        float d = sample1( p + 0.5 );

        d = smoothstep( threshold - range, threshold + range, d ) * opacity;

        float col = shading( p + 0.5 ) * 3.0 + ( ( p.x + p.y ) * 0.25 ) + 0.2;

        ac.rgb += ( 1.0 - ac.a ) * d * col;

        ac.a += ( 1.0 - ac.a ) * d;

        if ( ac.a >= 0.95 ) break;

        p += rayDir * stepSize;

      }

      color = linearToSRGB( ac );

      if ( color.a == 0.0 ) discard;

    }
  `;

  // Cartoon ocean vertex shader (no vertex displacement - plane stays flat)
  private oceanVertexShader = /* glsl */ `
    varying vec2 vUv;
    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      vUv = uv;
      vNormal = normalize(normalMatrix * normal);

      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;

      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  // Cartoon ocean fragment shader (animated colors only, no geometry movement)
  // Includes manual fog support so the sea edges fade into the fog
  private oceanFragmentShader = /* glsl */ `
    varying vec2 vUv;
    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    uniform float uTime;
    uniform vec3 uSunDirection;
    uniform vec3 uDeepColor;
    uniform vec3 uShallowColor;
    uniform vec3 uFoamColor;
    uniform vec3 uHighlightColor;

    // Three.js fog uniforms (injected automatically when fog: true)
    uniform vec3 fogColor;
    uniform float fogNear;
    uniform float fogFar;

    // Fake wave pattern computed in fragment (visual only, no displacement)
    float wave(vec2 p, float freq, float speed, vec2 dir) {
      return sin(dot(p, dir) * freq + uTime * speed);
    }

    void main() {
      vec3 normal = normalize(vNormal);
      vec3 viewDir = normalize(cameraPosition - vWorldPosition);
      vec3 sunDir = normalize(uSunDirection);

      // Compute fake wave height for color variation (no vertex movement)
      float w1 = wave(vWorldPosition.xz, 0.3, 1.2, vec2(1.0, 0.3)) * 0.4;
      float w2 = wave(vWorldPosition.xz, 0.5, 0.8, vec2(0.3, 1.0)) * 0.25;
      float w3 = wave(vWorldPosition.xz, 0.8, 1.5, vec2(-0.5, 0.7)) * 0.15;
      float w4 = wave(vWorldPosition.xz, 1.2, 2.0, vec2(0.7, -0.4)) * 0.08;
      float fakeWaveHeight = w1 + w2 + w3 + w4;

      // Fresnel effect for edge brightening
      float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);

      // Toon-style color banding based on fake wave pattern
      float heightNorm = (fakeWaveHeight + 0.8) / 1.6;
      float band = floor(heightNorm * 4.0) / 4.0;

      // Base water color: blend between deep and shallow using banded height
      vec3 waterColor = mix(uDeepColor, uShallowColor, band);

      // Add fresnel rim lighting
      waterColor = mix(waterColor, uHighlightColor, fresnel * 0.4);

      // Specular highlight from sun (toon-style: hard edge)
      vec3 halfVec = normalize(sunDir + viewDir);
      float specular = max(dot(normal, halfVec), 0.0);
      float toonSpec = step(0.92, specular);
      waterColor += uHighlightColor * toonSpec * 0.6;

      // Foam lines (animated in fragment, no geometry change)
      float foamLine = sin(vWorldPosition.x * 0.8 + vWorldPosition.z * 0.6 + uTime * 0.5);
      foamLine = smoothstep(0.7, 0.9, foamLine) * smoothstep(0.2, 0.5, fakeWaveHeight);
      waterColor = mix(waterColor, uFoamColor, foamLine * 0.7);

      // Subtle diffuse lighting from sun
      float diffuse = max(dot(normal, sunDir), 0.0) * 0.3 + 0.7;
      waterColor *= diffuse;

      // Apply fog: blend water into fog color based on distance from camera
      float fogDepth = length(vWorldPosition - cameraPosition);
      float fogFactor = smoothstep(fogNear, fogFar, fogDepth);
      waterColor = mix(waterColor, fogColor, fogFactor);

      // Also fade alpha so the sea plane disappears entirely at the fog edge
      float alpha = mix(0.85, 0.0, fogFactor);

      gl_FragColor = vec4(waterColor, alpha);
    }
  `;

  constructor(container: HTMLDivElement, options: EngineOptions) {
    this.options = options;
    this.container = container;
    this.inputState = createInputState();

    // Renderer — reduce quality on mobile
    const isMobile = options.isMobile;
    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = isMobile ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );

    // Lighting: ONLY the sun light - all scene illumination comes from the Sun object
    this.sunLight = new THREE.DirectionalLight(0xfff4e6, 1.5);
    this.sunLight.position.set(8, 12, 6);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = isMobile ? 512 : 2048;
    this.sunLight.shadow.mapSize.height = isMobile ? 512 : 2048;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.05;
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 50;
    this.sunLight.shadow.camera.left = -15;
    this.sunLight.shadow.camera.right = 15;
    this.sunLight.shadow.camera.top = 15;
    this.sunLight.shadow.camera.bottom = -15;
    this.scene.add(this.sunLight);

    // Moonlight: faint blue-ish fill so assets aren't pitch-black at night
    this.moonLight = new THREE.DirectionalLight(0x8090c0, 0);
    this.moonLight.position.set(-5, 10, -3);
    this.scene.add(this.moonLight);

    // Scene fog - near/far will be updated after loading Visibility asset from scene.glb
    // Start with permissive defaults so nothing is hidden before the scene loads
    this.sceneFog = new THREE.Fog(0x87ceeb, 800, 1000);
    this.scene.fog = this.sceneFog;

    // Sky
    this.initSky();

    // Subsystems
    this.grassSystem = new GrassSystem(isMobile);
    this.npcManager = new NPCManager();

    // Controls
    if (options.isMobile) {
      this.mobileInput = new MobileInputManager(this.camera, this.inputState);
    } else {
      this.fpControls = new FirstPersonControls(
        this.camera,
        this.renderer.domElement,
        this.inputState
      );
    }

    // Resize handler
    window.addEventListener('resize', this.onResize);
  }

  async init(): Promise<void> {
    try {
      const loader = new GLTFLoader();

      // Load scene.glb and Sun.glb in parallel
      const [gltf, sunGltf] = await Promise.all([
        new Promise<any>((resolve, reject) => {
          loader.load(
            process.env.NEXT_PUBLIC_SCENE_GLB_URL || '/models/scene.glb',
            resolve,
            (progress) => {
              if (progress.total > 0) {
                this.options.onProgress(
                  (progress.loaded / progress.total) * 90
                );
              }
            },
            reject
          );
        }),
        new Promise<any>((resolve, reject) => {
          loader.load('/models/Sun.glb', resolve, undefined, reject);
        }),
      ]);

      if (this.disposed) return;

      const model = gltf.scene as THREE.Group;

      // Enable shadows — on mobile only key objects cast shadows
      const shadowCasters = ['Shrimp_god_statue', 'House', 'Bridge'];
      model.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) {
          (child as THREE.Mesh).receiveShadow = true;
          if (this.options.isMobile) {
            const shouldCast = shadowCasters.some(
              (name) => child.name.includes(name) || (child.parent && child.parent.name.includes(name))
            );
            (child as THREE.Mesh).castShadow = shouldCast;
          } else {
            (child as THREE.Mesh).castShadow = true;
          }
        }
      });

      this.scene.add(model);

      // Play scene animations (propellers etc.)
      if (gltf.animations && gltf.animations.length > 0) {
        this.mixer = new THREE.AnimationMixer(model);
        gltf.animations.forEach((clip: THREE.AnimationClip) => {
          this.mixer!.clipAction(clip).play();
        });
        console.log(
          `Playing ${gltf.animations.length} scene animation(s):`,
          gltf.animations.map((a: THREE.AnimationClip) => a.name)
        );
      }

      // --- Extract orbit reference points from scene.glb ---
      let isleNode: THREE.Object3D | null = null;
      let sunPointNode: THREE.Object3D | null = null;
      let seaNode: THREE.Object3D | null = null;
      let visibilityNode: THREE.Object3D | null = null;

      model.traverse((child: THREE.Object3D) => {
        if (child.name === 'Isle') isleNode = child;
        if (child.name === 'Sun-point') sunPointNode = child;
        if (child.name === 'Sea') seaNode = child;
        if (child.name === 'Visibility') visibilityNode = child;
      });

      // Isle center: the orbit center for sun/moon
      if (isleNode) {
        (isleNode as THREE.Object3D).updateWorldMatrix(true, false);
        this.isleCenter.setFromMatrixPosition(
          (isleNode as THREE.Object3D).matrixWorld
        );
        console.log('Isle center for orbit:', this.isleCenter);
      } else {
        console.warn('Isle node not found, using origin as orbit center');
      }

      // Sun-point: defines the zenith height
      if (sunPointNode) {
        (sunPointNode as THREE.Object3D).updateWorldMatrix(true, false);
        const sunPt = new THREE.Vector3().setFromMatrixPosition(
          (sunPointNode as THREE.Object3D).matrixWorld
        );
        this.sunPointY = sunPt.y;
        // Orbit radius: the distance from Isle center XZ to Sun-point XZ,
        // or if they are vertically aligned, use the height as the radius
        const dx = sunPt.x - this.isleCenter.x;
        const dz = sunPt.z - this.isleCenter.z;
        const horizontalDist = Math.sqrt(dx * dx + dz * dz);
        // The orbit radius should be large enough so the sun sweeps from zenith down to below sea
        this.orbitRadius = Math.max(
          horizontalDist,
          this.sunPointY - this.isleCenter.y,
          400
        );
        console.log(
          'Sun-point Y:',
          this.sunPointY,
          'Orbit radius:',
          this.orbitRadius
        );
      } else {
        console.warn('Sun-point not found, using defaults');
        this.orbitRadius = 300;
        this.sunPointY = 200;
      }

      // Sea plane: get its Y level and apply cartoon shader
      if (seaNode) {
        (seaNode as THREE.Object3D).updateWorldMatrix(true, false);
        const seaPos = new THREE.Vector3().setFromMatrixPosition(
          (seaNode as THREE.Object3D).matrixWorld
        );
        this.seaLevel = seaPos.y;
        console.log('Sea level:', this.seaLevel);

        // Apply cartoon ocean shader to the Sea mesh (feature 3)
        this.applyCartoonOceanShader(seaNode as THREE.Object3D);
      } else {
        console.warn('Sea node not found, skipping ocean shader');
      }

      // Visibility circle: defines the radius within which the camera can see.
      // Beyond this radius, fog completely hides objects.
      if (visibilityNode) {
        const visObj = visibilityNode as THREE.Object3D;
        visObj.updateWorldMatrix(true, true);

        // Try multiple methods to get the visibility radius:
        // 1. Bounding box of the object (works if it has geometry)
        const visBbox = new THREE.Box3().setFromObject(visObj);
        const visSize = visBbox.getSize(new THREE.Vector3());
        const visCenter = visBbox.getCenter(new THREE.Vector3());
        const bboxRadius = Math.max(visSize.x, visSize.z) / 2;

        // 2. If the object has scale, the scale itself encodes the radius
        const worldScale = new THREE.Vector3();
        visObj.getWorldScale(worldScale);
        const scaleRadius = Math.max(worldScale.x, worldScale.z);

        // Use the larger of bounding box radius or scale-based radius
        // Blender circles exported as mesh use bbox; curves use scale
        this.visibilityRadius = Math.max(bboxRadius, scaleRadius);

        console.log('Visibility debug — bbox size:', visSize, 'bboxRadius:', bboxRadius,
          'worldScale:', worldScale, 'scaleRadius:', scaleRadius,
          'FINAL radius:', this.visibilityRadius);

        // Hide the visibility circle (it's only a reference)
        visObj.visible = false;

        // Fog: starts fading at 70% of the radius, fully opaque at 100%
        if (this.sceneFog) {
          this.sceneFog.near = this.visibilityRadius * 0.7;
          this.sceneFog.far = this.visibilityRadius;
          console.log('Fog set — near:', this.sceneFog.near, 'far:', this.sceneFog.far);
        }
      } else {
        console.warn('Visibility node not found, using default fog distance');
      }

      // --- Setup Sun model from Sun.glb (feature 1) ---
      this.setupSunModel(sunGltf);

      // Extract camera position from "Main" node
      let mainNode: THREE.Object3D | null = null;
      model.traverse((child: THREE.Object3D) => {
        if (child.name === 'Main') {
          mainNode = child;
        }
      });

      // Collect environment meshes for ground collision FIRST (needed for spawn raycast)
      const envNames = [
        'Bridge',
        'House',
        'Island',
        'Propellers',
        'Shrimp_god_statue',
        'Sky_city',
      ];
      model.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) {
          const isEnv = envNames.some(
            (name) =>
              child.name.includes(name) ||
              (child.parent && child.parent.name.includes(name))
          );
          const isTerrain =
            child.name.startsWith('Mesh_0') || child.name.startsWith('Mesh_');
          if (isEnv || isTerrain) {
            this.groundMeshes.push(child as THREE.Mesh);
          }
        }
      });
      console.log(
        `Collected ${this.groundMeshes.length} ground meshes for collision`
      );

      // Spawn camera directly on the ground (no falling)
      let spawnX: number, spawnZ: number;
      if (mainNode) {
        (mainNode as THREE.Object3D).updateWorldMatrix(true, false);
        const pos = new THREE.Vector3().setFromMatrixPosition(
          (mainNode as THREE.Object3D).matrixWorld
        );
        spawnX = pos.x;
        spawnZ = pos.z;
      } else {
        spawnX = this.isleCenter.x;
        spawnZ = this.isleCenter.z + 5;
        console.warn('Main node not found, using Isle center as spawn');
      }

      // Raycast straight down from high above to find the ground surface
      const spawnRay = new THREE.Raycaster();
      const spawnOrigin = new THREE.Vector3(spawnX, 500, spawnZ);
      spawnRay.set(spawnOrigin, new THREE.Vector3(0, -1, 0));
      spawnRay.far = 1000;
      const spawnHits = spawnRay.intersectObjects(this.groundMeshes, false);

      if (spawnHits.length > 0) {
        const groundY = spawnHits[0].point.y;
        this.camera.position.set(spawnX, groundY + this.playerHeight, spawnZ);
        console.log('Camera spawned on ground at:', this.camera.position);
      } else {
        // Fallback if raycast misses: use isle center Y + offset
        this.camera.position.set(spawnX, this.isleCenter.y + this.playerHeight + 2, spawnZ);
        console.warn('Spawn raycast missed, using fallback Y');
      }
      this.verticalVelocity = 0;
      this.isGrounded = true;

      // Volumetric effects — skip entirely on mobile (biggest GPU cost)
      if (!this.options.isMobile) {
        this.createVolumetricCloud(model);
        this.createIslandFog(model);
      }

      // Create spherical point light around the Shrimp_god_statue (Lobster statue)
      this.setupStatueLight(model);

      // Initialize grass system
      this.grassSystem.init(model);
      const grassMesh = this.grassSystem.getMesh();
      if (grassMesh) {
        this.scene.add(grassMesh);
        console.log('Grass system initialized');
      }

      // Initialize NPC shrimps
      await this.npcManager.init(model, this.scene, this.options.isMobile);
      console.log('NPCs initialized');

      // Setup spatial audio: music source at the centroid of the 3 closest NPCs
      this.setupSpatialAudio(this.camera.position.clone());

      // Signal loading complete
      this.options.onProgress(100);
      this.options.onLoaded();

      // Start render loop
      this.renderer.setAnimationLoop(this.animate);
    } catch (error) {
      console.error('Failed to initialize scene:', error);
    }
  }

  /**
   * Setup the Sun model loaded from Sun.glb (feature 1).
   * Replaces the old procedural yellow sphere.
   */
  private setupSunModel(sunGltf: any): void {
    const sunScene = sunGltf.scene as THREE.Group;

    // Enable emissive look - Sun should glow, not receive shadows, not affected by fog
    sunScene.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        // Exempt from scene fog
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => { (m as any).fog = false; });
        } else {
          (mesh.material as any).fog = false;
        }
      }
    });

    // Boost emissive so the sun visually glows bright
    sunScene.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          const std = mat as THREE.MeshStandardMaterial;
          if (std.emissive) {
            std.emissive.set(0xffdd44);
            std.emissiveIntensity = 4.0;
          }
        }
      }
    });

    // Scale the sun model appropriately
    // Compute its bounding box to determine a good scale
    const bbox = new THREE.Box3().setFromObject(sunScene);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    // Target visual size ~50 units diameter in the sky
    const targetSize = 50;
    const scaleFactor = targetSize / maxDim;
    sunScene.scale.setScalar(scaleFactor);

    // Attach a bright point light to the sun so it radiates light in all directions
    this.sunPointLight = new THREE.PointLight(0xfff0cc, 0, 500, 1.0);
    sunScene.add(this.sunPointLight);

    this.sunModel = sunScene;
    this.scene.add(sunScene);

    console.log('Sun.glb model loaded with point light');
  }

  /**
   * Apply cartoon ocean shader to the Sea plane (feature 3).
   */
  private applyCartoonOceanShader(seaObj: THREE.Object3D): void {
    // The Sea object might be a mesh directly or contain child meshes
    let targetMesh: THREE.Mesh | null = null;

    if ((seaObj as THREE.Mesh).isMesh) {
      targetMesh = seaObj as THREE.Mesh;
    } else {
      seaObj.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh && !targetMesh) {
          targetMesh = child as THREE.Mesh;
        }
      });
    }

    if (!targetMesh) {
      console.warn('No mesh found in Sea object for ocean shader');
      return;
    }

    // Ensure the geometry has UVs; if not, generate them from position
    const geo = targetMesh.geometry;
    if (!geo.attributes.uv) {
      // Generate simple planar UVs from XZ
      const posAttr = geo.attributes.position;
      const uvs = new Float32Array(posAttr.count * 2);
      for (let i = 0; i < posAttr.count; i++) {
        uvs[i * 2] = posAttr.getX(i) * 0.01;
        uvs[i * 2 + 1] = posAttr.getZ(i) * 0.01;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }

    // Increase subdivisions for wave displacement if geometry is too simple
    // We need enough vertices for visible waves

    // Get current fog values for initial uniform setup
    const fog = this.scene.fog as THREE.Fog | null;
    const material = new THREE.ShaderMaterial({
      vertexShader: this.oceanVertexShader,
      fragmentShader: this.oceanFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uDeepColor: { value: new THREE.Color(0x0a4a7a) }, // deep ocean blue
        uShallowColor: { value: new THREE.Color(0x2e9bd6) }, // lighter blue
        uFoamColor: { value: new THREE.Color(0xe8f4f8) }, // white foam
        uHighlightColor: { value: new THREE.Color(0xaaddff) }, // specular highlight
        // Fog uniforms required by Three.js when fog: true
        fogColor: { value: fog ? fog.color.clone() : new THREE.Color(0x87ceeb) },
        fogNear: { value: fog ? fog.near : 800 },
        fogFar: { value: fog ? fog.far : 1000 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: true,
    });

    // Dispose old material
    if (targetMesh.material) {
      if (Array.isArray(targetMesh.material)) {
        targetMesh.material.forEach((m) => m.dispose());
      } else {
        (targetMesh.material as THREE.Material).dispose();
      }
    }

    targetMesh.material = material;
    targetMesh.castShadow = false;
    targetMesh.receiveShadow = false;
    this.seaMaterial = material;
    this.seaMesh = targetMesh;

    console.log('Applied cartoon ocean shader to Sea plane');
  }

  /**
   * Load the HDR EXR skybox for realistic environment lighting and sky.
   */
  private initSky(): void {
    const exrLoader = new EXRLoader();
    exrLoader.load('/models/citrus_orchard_road_puresky_2k.exr', (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this.hdrTexture = texture;

      // Set as both background and environment map for PBR lighting
      this.scene.background = texture;
      this.scene.environment = texture;

      console.log('HDR skybox loaded: citrus_orchard_road_puresky_2k.exr');
    });

    // Create visible moon object (sun is now loaded from glb)
    this.initCelestialBodies();

    // Create star field for night sky
    this.initStars();
  }

  /**
   * Create a field of ~2000 stars distributed on a sphere.
   * Stars fade in at night and slowly rotate.
   */
  private initStars(): void {
    const starCount = this.options.isMobile ? 500 : 2000;
    const positions = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      const phi = Math.acos(2 * Math.random() - 1); // uniform distribution on sphere
      const theta = Math.random() * Math.PI * 2;
      const r = 300 + Math.random() * 100;

      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2.0,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    this.starField = new THREE.Points(geometry, material);
    this.starField.visible = false;
    this.starField.renderOrder = -1;
    this.scene.add(this.starField);
  }

  /**
   * Placeholder — moon removed per user request.
   * Sun is loaded from Sun.glb in init().
   */
  private initCelestialBodies(): void {
    this.sunMesh = null;
    this.sunGlow = null;
  }

  /**
   * Drive the full day-night cycle each frame.
   *
   * MODIFIED: Sun now orbits around the Isle center position.
   * The orbit is a circular path in the vertical plane, with the highest point
   * matching the Sun-point Y position, and the lowest point dipping below sea level.
   *
   * Phase mapping (one full period = cycleDuration seconds):
   *   phase 0        -> sunrise   (sun at sea level, rising)
   *   phase PI/2     -> noon      (sun at zenith / Sun-point height)
   *   phase PI       -> sunset    (sun at sea level, descending)
   *   phase 3*PI/2   -> midnight  (sun at nadir, deep below sea)
   */
  private updateDayNightCycle(elapsed: number): void {
    if (!this.sunLight) return;

    // Phase in [0, 2*PI), cycling every `cycleDuration` seconds
    const phase =
      ((elapsed % this.cycleDuration) / this.cycleDuration) * Math.PI * 2;

    // Sun elevation: sin(phase) maps phase to [-1, 1]
    const elevation = Math.sin(phase);

    // --- Compute sun world position: full circular orbit around Isle center ---
    // The orbit is a circle in a vertical plane. cos(phase) drives the horizontal
    // position so the sun rises from one side, crosses the zenith, and sets on
    // the OPPOSITE side before going below the sea and coming back around.

    const orbitAmplitudeY = (this.sunPointY - this.seaLevel) * 1.8;

    const sunY = this.seaLevel + elevation * orbitAmplitudeY;
    const sunX = this.isleCenter.x + this.orbitRadius * Math.cos(phase);
    const sunZ = this.isleCenter.z + this.orbitRadius * Math.sin(phase) * 0.3;

    // Store actual sun world position
    this._sunPosition.set(sunX, sunY, sunZ);

    const sunHeight = elevation; // [-1, 1]

    // --- Sky transition: smooth HDR dimming, no orange ---
    //
    // Always keep HDR as background, control brightness via backgroundIntensity.
    // sunHeight  0.3 → 1.0 : full HDR (intensity 1.0)
    // sunHeight -0.3 → 0.3 : HDR dims smoothly
    // sunHeight -1.0 → -0.3: near-dark (intensity ~0.02)
    //
    const hdrT = THREE.MathUtils.smoothstep(sunHeight, -0.3, 0.3);
    const hdrIntensity = THREE.MathUtils.lerp(0.02, 1.0, hdrT);

    if (this.hdrTexture) {
      this.scene.background = this.hdrTexture;
      this.scene.environment = this.hdrTexture;
      this.scene.backgroundIntensity = hdrIntensity;
      this.scene.environmentIntensity = hdrIntensity;
    }

    // Fog color follows the same brightness curve (reuse _fogColor to avoid clone())
    this._fogColor.setHex(0x060a18).lerp(this._dayColor, hdrT);

    // --- Update fog color to match sky (feature 4) ---
    if (this.sceneFog) {
      this.sceneFog.color.copy(this._fogColor);
    }

    // --- Directional (sun) light: follows sun world position ---
    // Point the light from the sun toward the Isle center
    const lightDir = this._sunPosition
      .clone()
      .sub(this.isleCenter)
      .normalize();
    this.sunLight.position
      .copy(lightDir)
      .multiplyScalar(this.sunDistance);

    // Sun directional light intensity (reduced — sun point light provides additional radiance)
    const sunIntensity =
      sunHeight > 0.05
        ? THREE.MathUtils.smoothstep(sunHeight, 0.05, 0.5) * 1.8
        : sunHeight > -0.05
          ? THREE.MathUtils.smoothstep(sunHeight, -0.05, 0.05) * 0.2
          : 0;
    this.sunLight.intensity = sunIntensity;
    this.sunLight.color.set(0xffee88);

    // --- Sun point light: strong radial glow from the sun object ---
    if (this.sunPointLight) {
      const sunPtIntensity =
        sunHeight > 0.05
          ? THREE.MathUtils.smoothstep(sunHeight, 0.05, 0.4) * 8.0
          : 0;
      this.sunPointLight.intensity = sunPtIntensity;
    }

    // --- Moonlight: faint fill when sun is below horizon ---
    if (this.moonLight) {
      // Fade in as sun drops below 0, max at deep night
      const moonT = THREE.MathUtils.smoothstep(-sunHeight, 0.0, 0.3);
      this.moonLight.intensity = moonT * 0.8;
    }

    // --- Statue point light: glow at night ---
    if (this.statueLight) {
      const statueLightT = THREE.MathUtils.smoothstep(-sunHeight, 0.0, 0.2);
      this.statueLight.intensity = statueLightT * 6.0;
    }

    // --- Update grass lighting to match day-night (moon provides faint fill at night) ---
    const grassLightDir = this._sunPosition
      .clone()
      .sub(this.isleCenter)
      .normalize();
    if (sunHeight <= 0) {
      grassLightDir.negate();
    }
    const moonFill = THREE.MathUtils.smoothstep(-sunHeight, 0.0, 0.3) * 0.06;
    const grassAmbient = sunHeight > 0
      ? THREE.MathUtils.lerp(0.02, 0.12, THREE.MathUtils.smoothstep(sunHeight, 0, 0.3))
      : 0.02 + moonFill;
    // At night blend grass light color toward moonlight tint
    const grassLightColor = this.sunLight.color.clone();
    if (sunHeight < 0) {
      const moonColor = new THREE.Color(0x8090c0);
      const nightT = THREE.MathUtils.smoothstep(-sunHeight, 0.0, 0.3);
      grassLightColor.lerp(moonColor, nightT * 0.6);
    }
    this.grassSystem.updateLighting(
      grassLightDir,
      grassLightColor,
      grassAmbient
    );

    // --- Celestial body positions & visibility ---
    this.updateCelestialBodies(elevation, elapsed);

    // --- Update sea shader uniforms ---
    if (this.seaMaterial) {
      this.seaMaterial.uniforms.uTime.value = elapsed;
      this.seaMaterial.uniforms.uSunDirection.value
        .copy(this._sunPosition)
        .sub(this.isleCenter)
        .normalize();
      // Sync fog uniforms with scene fog
      if (this.sceneFog) {
        this.seaMaterial.uniforms.fogColor.value.copy(this.sceneFog.color);
        this.seaMaterial.uniforms.fogNear.value = this.sceneFog.near;
        this.seaMaterial.uniforms.fogFar.value = this.sceneFog.far;
      }
    }

    // --- Stars visibility: fade in at night (1 - smoothstep so opacity=1 when elevation is low) ---
    if (this.starField) {
      const starOpacity = 1 - THREE.MathUtils.smoothstep(elevation, -0.15, 0.05);
      (this.starField.material as THREE.PointsMaterial).opacity = starOpacity;
      this.starField.visible = starOpacity > 0.001;
      this.starField.rotation.y = elapsed * 0.003;
    }

    // --- Tone mapping exposure ---
    if (sunHeight > 0) {
      this.renderer.toneMappingExposure = THREE.MathUtils.lerp(
        0.5,
        1.2,
        THREE.MathUtils.smoothstep(sunHeight, 0, 0.3)
      );
    } else {
      this.renderer.toneMappingExposure = THREE.MathUtils.lerp(
        0.5,
        0.25,
        THREE.MathUtils.smoothstep(Math.abs(sunHeight), 0, 0.5)
      );
    }
  }

  /**
   * Position the visible sun model.
   *
   * @param elevation  Sun elevation in [-1, 1] (positive = above horizon)
   * @param elapsed    Total elapsed time for sun self-rotation
   */
  private updateCelestialBodies(
    elevation: number,
    elapsed: number
  ): void {
    // --- Sun model position: use the computed world position ---
    if (this.sunModel) {
      this.sunModel.position.copy(this._sunPosition);
      // Slow self-rotation on its own axis
      this.sunModel.rotation.y = elapsed * 0.2;
      this.sunModel.rotation.x = elapsed * 0.05;
      this.sunModel.visible = true;
    }
  }

  /**
   * Place a PointLight at the Shrimp_god_statue (Lobster statue) position.
   * Intensity is driven by the day-night cycle (bright at night, off during day).
   */
  private setupStatueLight(model: THREE.Group): void {
    let statueNode: THREE.Object3D | null = null;
    model.traverse((child: THREE.Object3D) => {
      if (child.name === 'Shrimp_god_statue') {
        statueNode = child;
      }
    });

    if (!statueNode) {
      console.warn('Shrimp_god_statue not found, skipping statue light');
      return;
    }

    (statueNode as THREE.Object3D).updateWorldMatrix(true, true);
    const statuePos = new THREE.Vector3();
    (statueNode as THREE.Object3D).getWorldPosition(statuePos);

    // Raise the light slightly above the statue center
    const bbox = new THREE.Box3().setFromObject(statueNode as THREE.Object3D);
    const height = bbox.getSize(new THREE.Vector3()).y;
    statuePos.y += height * 0.6;

    this.statueLight = new THREE.PointLight(0xd4c8ff, 0, 18, 1.2);
    this.statueLight.position.copy(statuePos);
    this.scene.add(this.statueLight);

    console.log('Statue point light placed at:', statuePos);
  }

  /**
   * Create a volumetric cloud volume around the Sky_city (Laputa castle) using
   * raymarched 3D noise in a GLSL3 RawShaderMaterial, adapted from the Three.js
   * cloud volume example.
   */
  private createVolumetricCloud(model: THREE.Group): void {
    let skyCityNode: THREE.Object3D | null = null;
    model.traverse((child: THREE.Object3D) => {
      if (child.name === 'Sky_city') {
        skyCityNode = child;
      }
    });

    if (!skyCityNode) {
      console.warn(
        'Sky_city node not found, skipping volumetric cloud creation'
      );
      return;
    }

    // Compute bounding box in world space
    (skyCityNode as THREE.Object3D).updateWorldMatrix(true, true);
    const bbox = new THREE.Box3().setFromObject(
      skyCityNode as THREE.Object3D
    );
    const center = bbox.getCenter(new THREE.Vector3());
    const bboxSize = bbox.getSize(new THREE.Vector3());

    console.log('Sky_city center:', center, 'size:', bboxSize);

    // Generate 3D noise texture (128^3) using Perlin noise
    const texSize = 128;
    const data = new Uint8Array(texSize * texSize * texSize);

    let i = 0;
    const scale = 0.05;
    const perlin = new ImprovedNoise();
    const vector = new THREE.Vector3();

    for (let z = 0; z < texSize; z++) {
      for (let y = 0; y < texSize; y++) {
        for (let x = 0; x < texSize; x++) {
          const d =
            1.0 -
            vector
              .set(x, y, z)
              .subScalar(texSize / 2)
              .divideScalar(texSize)
              .length();
          // Base noise value
          let noiseVal =
            (128 +
              128 *
                perlin.noise(
                  (x * scale) / 1.5,
                  y * scale,
                  (z * scale) / 1.5
                )) *
            d *
            d;
          // Secondary low-frequency noise to carve holes in the cloud
          const holeNoise = perlin.noise(
            x * 0.02,
            y * 0.025,
            z * 0.02
          );
          if (holeNoise > 0.15) {
            noiseVal *= Math.max(0, 1.0 - (holeNoise - 0.15) * 3.0);
          }
          data[i] = noiseVal;
          i++;
        }
      }
    }

    const texture = new THREE.Data3DTexture(data, texSize, texSize, texSize);
    texture.format = THREE.RedFormat;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    this.cloudTexture = texture;

    // Create the RawShaderMaterial with GLSL3
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        base: { value: new THREE.Color(0.92, 0.94, 0.97) }, // light blue-white cloud
        map: { value: texture },
        cameraPos: { value: new THREE.Vector3() },
        threshold: { value: 0.3 },
        opacity: { value: 0.18 },
        range: { value: 0.1 },
        steps: { value: 80 },
        frame: { value: 0 },
      },
      vertexShader: this.volumetricVertexShader,
      fragmentShader: this.volumetricFragmentShader,
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
    });
    this.cloudMaterial = material;

    // Create box mesh and scale it to surround the Sky_city
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry, material);

    // Expand the cloud volume well beyond the castle bounding box
    const expand = 2.2;
    mesh.scale.set(
      bboxSize.x * expand,
      bboxSize.y * expand * 0.8,
      bboxSize.z * expand
    );
    mesh.position.copy(center);

    mesh.renderOrder = 999;
    this.cloudMesh = mesh;
    this.scene.add(mesh);

    console.log('Created volumetric cloud around Sky_city');
  }

  /**
   * Create a volumetric fog volume around the bottom portion of the Island node.
   * Uses the same raymarching shaders as the Sky_city cloud but with different
   * noise scale and uniform values for a softer, wider fog effect.
   */
  private createIslandFog(model: THREE.Group): void {
    let islandNode: THREE.Object3D | null = null;
    model.traverse((child: THREE.Object3D) => {
      if (child.name === 'Island') {
        islandNode = child;
      }
    });

    if (!islandNode) {
      console.warn('Island node not found, skipping island fog creation');
      return;
    }

    // Compute bounding box in world space
    (islandNode as THREE.Object3D).updateWorldMatrix(true, true);
    const bbox = new THREE.Box3().setFromObject(
      islandNode as THREE.Object3D
    );
    const center = bbox.getCenter(new THREE.Vector3());
    const bboxSize = bbox.getSize(new THREE.Vector3());

    console.log('Island center:', center, 'size:', bboxSize);

    // Generate 3D noise texture (128^3) using Perlin noise with smoother scale
    const texSize = 128;
    const data = new Uint8Array(texSize * texSize * texSize);

    let i = 0;
    const scale = 0.03; // smoother fog than castle cloud
    const perlin = new ImprovedNoise();
    const vector = new THREE.Vector3();

    for (let z = 0; z < texSize; z++) {
      for (let y = 0; y < texSize; y++) {
        for (let x = 0; x < texSize; x++) {
          const d =
            1.0 -
            vector
              .set(x, y, z)
              .subScalar(texSize / 2)
              .divideScalar(texSize)
              .length();
          data[i] =
            (128 +
              128 *
                perlin.noise(
                  (x * scale) / 1.5,
                  y * scale,
                  (z * scale) / 1.5
                )) *
            d *
            d;
          i++;
        }
      }
    }

    const texture = new THREE.Data3DTexture(data, texSize, texSize, texSize);
    texture.format = THREE.RedFormat;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    this.islandFogTexture = texture;

    // Create the RawShaderMaterial with GLSL3
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        base: { value: new THREE.Color(0.85, 0.88, 0.95) }, // slightly bluish fog
        map: { value: texture },
        cameraPos: { value: new THREE.Vector3() },
        threshold: { value: 0.25 },
        opacity: { value: 0.25 },
        range: { value: 0.1 },
        steps: { value: 97 },
        frame: { value: 0 },
      },
      vertexShader: this.volumetricVertexShader,
      fragmentShader: this.volumetricFragmentShader,
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
    });
    this.islandFogMaterial = material;

    // Create box mesh positioned at the bottom portion of the island
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry, material);

    // Position fog at the bottom 30% of the island
    const fogCenter = center.clone();
    fogCenter.y = bbox.min.y + bboxSize.y * 0.15;

    mesh.scale.set(
      bboxSize.x * 2.0, // wide around the island
      bboxSize.y * 0.4, // only covers bottom portion
      bboxSize.z * 2.0 // wide around the island
    );
    mesh.position.copy(fogCenter);

    mesh.renderOrder = 999;
    this.islandFogMesh = mesh;
    this.scene.add(mesh);

    console.log('Created volumetric fog around Island base');
  }

  /**
   * Setup spatial audio: music.mp3 is placed at the centroid of the 3 closest
   * NPC shrimp spawn points. The listening radius grows from that point (max volume)
   * to the camera spawn position (min volume / silence).
   */
  private setupSpatialAudio(cameraSpawnPos: THREE.Vector3): void {
    const spawnPositions = this.npcManager.getSpawnPositions();
    if (spawnPositions.length === 0) {
      console.warn('No NPC spawn positions available for spatial audio');
      return;
    }

    // Sort spawn positions by distance to camera spawn and pick the 3 closest
    const sorted = spawnPositions
      .map((pos) => ({ pos, dist: pos.distanceTo(cameraSpawnPos) }))
      .sort((a, b) => a.dist - b.dist);

    const closest3 = sorted.slice(0, Math.min(3, sorted.length));

    // Compute centroid of the closest 3 NPCs
    const centroid = new THREE.Vector3();
    for (const entry of closest3) {
      centroid.add(entry.pos);
    }
    centroid.divideScalar(closest3.length);

    // Max distance = distance from centroid to camera spawn position
    const maxDist = centroid.distanceTo(cameraSpawnPos);

    console.log('Audio source centroid:', centroid, 'maxDistance:', maxDist);

    // Defer AudioListener creation until first user gesture to avoid
    // "AudioContext was not allowed to start" warnings
    const initAudioOnGesture = () => {
      if (this.audioResumed || this.disposed) return;
      this.audioResumed = true;

      // Remove all listeners
      document.removeEventListener('click', initAudioOnGesture);
      document.removeEventListener('touchstart', initAudioOnGesture);
      document.removeEventListener('keydown', initAudioOnGesture);

      // Create AudioListener and attach to camera
      this.audioListener = new THREE.AudioListener();
      this.camera.add(this.audioListener);

      // Create a positional audio source
      this.positionalAudio = new THREE.PositionalAudio(this.audioListener);

      // Create an invisible object to hold the audio at the centroid
      this.audioMesh = new THREE.Object3D();
      this.audioMesh.position.copy(centroid);
      this.audioMesh.add(this.positionalAudio);
      this.scene.add(this.audioMesh);

      // Load and configure the audio
      const audioLoader = new THREE.AudioLoader();
      audioLoader.load('/music.mp3', (buffer) => {
        if (this.disposed || !this.positionalAudio) return;

        this.positionalAudio.setBuffer(buffer);
        this.positionalAudio.setLoop(true);
        this.positionalAudio.setVolume(1.0);
        this.positionalAudio.setRefDistance(1);
        this.positionalAudio.setMaxDistance(maxDist);
        this.positionalAudio.setRolloffFactor(1.5);
        this.positionalAudio.setDistanceModel('linear');
        this.positionalAudio.play();

        console.log('Spatial audio started after user gesture');
      });
    };

    // Store reference for cleanup in dispose()
    this._initAudioOnGesture = initAudioOnGesture;
    document.addEventListener('click', initAudioOnGesture);
    document.addEventListener('touchstart', initAudioOnGesture);
    document.addEventListener('keydown', initAudioOnGesture);
  }

  private animate = (): void => {
    if (this.disposed) return;

    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime;

    // Update desktop controls (reads keys, writes to inputState)
    if (this.fpControls) {
      this.fpControls.update();
    }

    // Apply movement from inputState
    const speed = 5;
    this.camera.getWorldDirection(this._direction);
    this._direction.y = 0;
    this._direction.normalize();

    this._right
      .crossVectors(this.camera.up, this._direction)
      .negate()
      .normalize();

    // Calculate desired horizontal movement
    const moveX =
      this._direction.x * this.inputState.moveForward * speed * delta +
      this._right.x * this.inputState.moveSide * speed * delta;
    const moveZ =
      this._direction.z * this.inputState.moveForward * speed * delta +
      this._right.z * this.inputState.moveSide * speed * delta;

    // Check forward collision before moving (wall detection)
    if (moveX !== 0 || moveZ !== 0) {
      this._rayForward.set(moveX, 0, moveZ).normalize();
      this._rayOrigin.copy(this.camera.position);
      this._rayOrigin.y -= this.playerHeight * 0.5; // ray from body center
      this._raycaster.set(this._rayOrigin, this._rayForward);
      this._raycaster.far = 0.5; // collision distance

      const wallHits = this._raycaster.intersectObjects(
        this.groundMeshes,
        false
      );
      if (wallHits.length === 0) {
        // No wall, apply movement
        this.camera.position.x += moveX;
        this.camera.position.z += moveZ;
      }
    }

    // Apply gravity
    this.verticalVelocity -= this.gravity * delta;
    this.camera.position.y += this.verticalVelocity * delta;

    // Raycast downward to find ground
    this._rayOrigin.copy(this.camera.position);
    this._rayOrigin.y += 5; // start ray from above
    this._raycaster.set(this._rayOrigin, this._rayDown);
    this._raycaster.far = 50;

    const groundHits = this._raycaster.intersectObjects(
      this.groundMeshes,
      false
    );
    if (groundHits.length > 0) {
      const groundY = groundHits[0].point.y;
      const targetY = groundY + this.playerHeight;

      if (this.camera.position.y <= targetY) {
        // Snap to ground
        this.camera.position.y = targetY;
        this.verticalVelocity = 0;
        this.isGrounded = true;
      } else {
        this.isGrounded = false;
      }
    } else {
      this.isGrounded = false;
    }

    // Update scene animations (propellers)
    if (this.mixer) {
      this.mixer.update(delta);
    }

    // Update grass
    this.grassSystem.update(elapsed);
    this.grassSystem.setPlayerPosition(this.camera.position);

    // Update NPCs
    this.npcManager.update(delta, this.camera.position);

    // Update sky / day-night cycle
    this.updateDayNightCycle(elapsed);

    // Update volumetric cloud around Sky_city
    if (this.cloudMesh && this.cloudMaterial) {
      this.cloudMaterial.uniforms.cameraPos.value.copy(this.camera.position);
      this.cloudMaterial.uniforms.frame.value++;
      this.cloudMesh.rotation.y = -performance.now() / 7500;
    }

    // Update volumetric fog around Island base
    if (this.islandFogMesh && this.islandFogMaterial) {
      this.islandFogMaterial.uniforms.cameraPos.value.copy(
        this.camera.position
      );
      this.islandFogMaterial.uniforms.frame.value++;
      this.islandFogMesh.rotation.y = -performance.now() / 12000;
    }

    // Render
    this.renderer.render(this.scene, this.camera);
  };

  // Called by React MobileControls component
  handleMobileMove(dx: number, dy: number): void {
    this.mobileInput?.handleMove(dx, dy);
  }

  handleMobileLook(dx: number, dy: number): void {
    this.mobileInput?.handleLook(dx, dy);
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    this.fpControls?.dispose();

    // Dispose Sun model from Sun.glb
    if (this.sunModel) {
      this.sunModel.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.geometry.dispose();
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else {
            (mesh.material as THREE.Material).dispose();
          }
        }
      });
      this.scene.remove(this.sunModel);
      this.sunModel = null;
    }

    // Dispose celestial body resources (legacy sun mesh if any)
    const celestials = [
      this.sunMesh,
      this.sunGlow,
    ];
    for (const mesh of celestials) {
      if (mesh) {
        (mesh.material as THREE.Material).dispose();
        mesh.geometry.dispose();
        this.scene.remove(mesh);
      }
    }
    this.sunMesh = this.sunGlow = null;

    // Dispose star field
    if (this.starField) {
      (this.starField.material as THREE.Material).dispose();
      this.starField.geometry.dispose();
      this.scene.remove(this.starField);
      this.starField = null;
    }

    // Dispose volumetric cloud resources
    if (this.cloudMesh) {
      this.cloudMesh.geometry.dispose();
      this.scene.remove(this.cloudMesh);
      this.cloudMesh = null;
    }
    if (this.cloudMaterial) {
      this.cloudMaterial.dispose();
      this.cloudMaterial = null;
    }
    if (this.cloudTexture) {
      this.cloudTexture.dispose();
      this.cloudTexture = null;
    }

    // Dispose island fog resources
    if (this.islandFogMesh) {
      this.islandFogMesh.geometry.dispose();
      this.scene.remove(this.islandFogMesh);
      this.islandFogMesh = null;
    }
    if (this.islandFogMaterial) {
      this.islandFogMaterial.dispose();
      this.islandFogMaterial = null;
    }
    if (this.islandFogTexture) {
      this.islandFogTexture.dispose();
      this.islandFogTexture = null;
    }

    // Dispose sea/ocean shader material
    if (this.seaMaterial) {
      this.seaMaterial.dispose();
      this.seaMaterial = null;
    }
    this.seaMesh = null;

    // Dispose sun point light (attached to sunModel, removed with it)
    this.sunPointLight = null;

    // Dispose moonlight
    if (this.moonLight) {
      this.scene.remove(this.moonLight);
      this.moonLight = null;
    }

    // Dispose statue point light
    if (this.statueLight) {
      this.scene.remove(this.statueLight);
      this.statueLight = null;
    }

    // Remove audio gesture listeners if still pending
    if (this._initAudioOnGesture) {
      document.removeEventListener('click', this._initAudioOnGesture);
      document.removeEventListener('touchstart', this._initAudioOnGesture);
      document.removeEventListener('keydown', this._initAudioOnGesture);
      this._initAudioOnGesture = null;
    }

    // Dispose spatial audio
    if (this.positionalAudio) {
      if (this.positionalAudio.isPlaying) {
        this.positionalAudio.stop();
      }
      this.positionalAudio.disconnect();
      this.positionalAudio = null;
    }
    if (this.audioMesh) {
      this.scene.remove(this.audioMesh);
      this.audioMesh = null;
    }
    if (this.audioListener) {
      this.camera.remove(this.audioListener);
      this.audioListener = null;
    }

    // Clear fog reference
    this.sceneFog = null;

    // Dispose HDR skybox texture
    if (this.hdrTexture) {
      this.hdrTexture.dispose();
      this.hdrTexture = null;
    }

    this.grassSystem.dispose();
    this.npcManager.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(
        this.renderer.domElement
      );
    }
  }
}
