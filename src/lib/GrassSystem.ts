import * as THREE from 'three';

const GRASS_CONFIG = {
    bladesPerVertex: 60,      // max grass blades spawned around each painted vertex
    bladesPerSquareUnit: 40,  // blades per square unit of area for face-based sampling
    maxBladesPerFace: 200,    // cap per triangle face to avoid huge triangles exploding
    bladeWidth: 0.025,
    bladeHeight: 0.25,
    bladeHeightVariation: 0.18,
    spreadRadius: 0.4,        // how far blades spread from vertex position
    windStrength: 0.1,
    windSpeed: 1.5,
    interactionRadius: 0.5,   // how close objects must be to bend grass
    interactionStrength: 0.4,
    colorBase: new THREE.Color(process.env.NEXT_PUBLIC_GRASS_COLOR_BASE || '#3d6b30'),
    colorTip: new THREE.Color(process.env.NEXT_PUBLIC_GRASS_COLOR_TIP || '#82c45c'),
};

const MAX_INTERACTORS = 16;

const grassVertexShader = /* glsl */`
    precision highp float;

    uniform float uTime;
    uniform float uWindStrength;
    uniform float uWindSpeed;
    uniform float uInteractionRadius;
    uniform float uInteractionStrength;
    uniform vec3 uInteractors[${MAX_INTERACTORS}];
    uniform int uInteractorCount;

    attribute vec3 instanceOffset;    // world position of grass blade base
    attribute float instanceAngle;    // random Y rotation per blade
    attribute float instanceHeight;   // height variation per blade
    attribute vec3 instanceNormal;    // surface normal at that vertex

    varying float vHeightFrac;
    varying vec3 vWorldPos;
    varying vec3 vNormal;

    mat3 rotateY(float angle) {
        float s = sin(angle);
        float c = cos(angle);
        return mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c);
    }

    void main() {
        // Height fraction (0 at base, 1 at tip)
        vHeightFrac = position.y;

        // Scale the blade
        vec3 pos = position;
        pos.y *= instanceHeight;
        pos.x *= 1.0;

        // Rotate blade around Y axis for variety
        pos = rotateY(instanceAngle) * pos;

        // Align blade to surface normal
        vec3 up = normalize(instanceNormal);
        vec3 tangent = normalize(cross(up, vec3(0.0, 0.0, 1.0)));
        if (length(tangent) < 0.01) {
            tangent = normalize(cross(up, vec3(1.0, 0.0, 0.0)));
        }
        vec3 bitangent = cross(up, tangent);
        mat3 surfaceTBN = mat3(tangent, up, bitangent);
        pos = surfaceTBN * pos;

        // World position of this vertex
        vec3 worldPos = instanceOffset + pos;

        // --- Wind ---
        float windPhase = uTime * uWindSpeed + instanceOffset.x * 2.5 + instanceOffset.z * 3.1;
        float windWave = sin(windPhase) * 0.6 + sin(windPhase * 2.3 + 1.5) * 0.4;
        vec3 windDir = normalize(vec3(1.0, 0.0, 0.6));
        float windEffect = vHeightFrac * vHeightFrac * uWindStrength * windWave;
        worldPos += windDir * windEffect;

        // --- Object interaction: push grass away ---
        for (int i = 0; i < ${MAX_INTERACTORS}; i++) {
            if (i >= uInteractorCount) break;
            vec3 objPos = uInteractors[i];
            vec3 toGrass = instanceOffset - objPos;
            float dist = length(toGrass);
            if (dist < uInteractionRadius && dist > 0.001) {
                float influence = 1.0 - (dist / uInteractionRadius);
                influence = influence * influence * uInteractionStrength;
                vec3 pushDir = normalize(toGrass);
                // Bend more at the tip
                worldPos += pushDir * influence * vHeightFrac * vHeightFrac * instanceHeight;
                // Also push down slightly to simulate bending
                worldPos.y -= influence * vHeightFrac * 0.3 * instanceHeight;
            }
        }

        vWorldPos = worldPos;
        vNormal = surfaceTBN * vec3(0.0, 0.0, 1.0);

        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
    }
`;

const grassFragmentShader = /* glsl */`
    precision highp float;

    uniform vec3 uColorBase;
    uniform vec3 uColorTip;
    uniform vec3 uLightDir;
    uniform vec3 uLightColor;
    uniform float uAmbientStrength;

    varying float vHeightFrac;
    varying vec3 vWorldPos;
    varying vec3 vNormal;

    void main() {
        // Gradient from base to tip
        vec3 grassColor = mix(uColorBase, uColorTip, vHeightFrac);

        // Slight random darkening based on world position
        float noise = fract(sin(dot(vWorldPos.xz, vec2(12.9898, 78.233))) * 43758.5453);
        grassColor *= 0.85 + noise * 0.15;

        // Simple diffuse lighting
        vec3 normal = normalize(vNormal);
        float diff = max(dot(normal, normalize(uLightDir)), 0.0);
        // Wrap lighting for softer look
        diff = diff * 0.5 + 0.5;

        vec3 ambient = uAmbientStrength * grassColor;
        vec3 diffuse = diff * uLightColor * grassColor;
        vec3 finalColor = ambient + diffuse;

        // Brighten tips slightly
        finalColor += vHeightFrac * vHeightFrac * uColorTip * 0.15;

        // Simple alpha cutoff at very base for blending
        float alpha = smoothstep(0.0, 0.05, vHeightFrac) * 0.95 + 0.05;

        gl_FragColor = vec4(finalColor, alpha);
    }
`;

export class GrassSystem {
    private grassMesh: THREE.Mesh | null = null;
    private interactors: THREE.Object3D[] = [];
    private _interactorWorldPos = new THREE.Vector3();
    private isMobile = false;

    constructor(isMobile = false) {
        this.isMobile = isMobile;
        if (isMobile) {
            // Drastically reduce grass density on mobile
            GRASS_CONFIG.bladesPerVertex = 8;
            GRASS_CONFIG.bladesPerSquareUnit = 6;
            GRASS_CONFIG.maxBladesPerFace = 30;
        }
    }

    /**
     * Build grass blade geometry (single blade as a tapered quad strip)
     */
    private createBladeGeometry(width: number, height: number, segments: number): THREE.BufferGeometry {
        const vertices: number[] = [];
        const seg = segments || 4;

        for (let i = 0; i <= seg; i++) {
            const t = i / seg;         // 0 at base, 1 at tip
            const w = width * (1.0 - t * 0.9); // taper toward tip
            const y = t;               // normalized height (scaled in shader)

            // Left vertex
            vertices.push(-w * 0.5, y, 0);
            // Right vertex
            vertices.push(w * 0.5, y, 0);
        }

        const indices: number[] = [];
        for (let i = 0; i < seg; i++) {
            const base = i * 2;
            indices.push(base, base + 1, base + 2);
            indices.push(base + 1, base + 3, base + 2);
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geom.setIndex(indices);
        geom.computeVertexNormals();
        return geom;
    }

    /**
     * Helper: get vertex brightness from the grass color attribute
     */
    private getVertexBrightness(grassAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number): number {
        const r = grassAttr.getX(index);
        const g = grassAttr.getY(index);
        const b = grassAttr.getZ(index);
        return (r + g + b) / 3.0;
    }

    /**
     * Extract grass spawn points from vertex colors.
     * Combines vertex-based spawning (original) with face-based sampling
     * to fill triangle interiors with grass.
     */
    private extractGrassPoints(mesh: THREE.Mesh): Array<{ position: THREE.Vector3; normal: THREE.Vector3; weight: number }> {
        const geometry = mesh.geometry;

        // Use "color_1" which is the Blender "grass" vertex paint layer
        // (Blender exports color attributes as COLOR_0 -> "color", COLOR_1 -> "color_1")
        const grassAttr = geometry.getAttribute('color_1');

        if (!grassAttr) {
            console.warn('No "color_1" attribute found. Available:', Object.keys(geometry.attributes));
            return [];
        }

        console.log(`Using "color_1" (grass layer): ${grassAttr.count} vertices, itemSize: ${grassAttr.itemSize}`);

        // Debug: sample vertex colors to understand painted vs unpainted
        let blackCount = 0, nonBlackCount = 0;
        for (let i = 0; i < grassAttr.count; i++) {
            const brightness = this.getVertexBrightness(grassAttr, i);
            if (brightness < 0.05) blackCount++;
            else nonBlackCount++;
        }
        console.log(`Vertex paint analysis: ${nonBlackCount} painted (non-black), ${blackCount} unpainted (black)`);

        // Sample a few of each type
        let sampledPainted = 0, sampledUnpainted = 0;
        for (let i = 0; i < grassAttr.count && (sampledPainted < 3 || sampledUnpainted < 3); i++) {
            const r = grassAttr.getX(i);
            const g = grassAttr.getY(i);
            const b = grassAttr.getZ(i);
            const brightness = (r + g + b) / 3.0;
            if (brightness >= 0.05 && sampledPainted < 3) {
                console.log(`  Painted v${i}: R=${r.toFixed(3)} G=${g.toFixed(3)} B=${b.toFixed(3)}`);
                sampledPainted++;
            } else if (brightness < 0.05 && sampledUnpainted < 3) {
                console.log(`  Unpainted v${i}: R=${r.toFixed(3)} G=${g.toFixed(3)} B=${b.toFixed(3)}`);
                sampledUnpainted++;
            }
        }

        const posAttr = geometry.getAttribute('position');
        const normalAttr = geometry.getAttribute('normal');

        mesh.updateMatrixWorld(true);
        const worldMatrix = mesh.matrixWorld;
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);

        const points: Array<{ position: THREE.Vector3; normal: THREE.Vector3; weight: number }> = [];

        // =====================================================================
        // PASS 1: Vertex-based grass (original behavior)
        // Grass grows where the "grass" vertex paint is BLACK
        // (black = grass, white/bright = no grass)
        // =====================================================================
        for (let i = 0; i < grassAttr.count; i++) {
            const brightness = this.getVertexBrightness(grassAttr, i);

            if (brightness < 0.5) {
                const localPos = new THREE.Vector3(
                    posAttr.getX(i),
                    posAttr.getY(i),
                    posAttr.getZ(i)
                );
                const worldPos = localPos.applyMatrix4(worldMatrix);

                const localNormal = new THREE.Vector3(
                    normalAttr.getX(i),
                    normalAttr.getY(i),
                    normalAttr.getZ(i)
                );
                const worldNormal = localNormal.applyMatrix3(normalMatrix).normalize();

                // Darker = stronger grass (invert brightness for weight)
                points.push({ position: worldPos, normal: worldNormal, weight: 1.0 - brightness });
            }
        }

        const vertexPointCount = points.length;
        console.log(`Extracted ${vertexPointCount} grass vertices out of ${grassAttr.count} total`);

        // =====================================================================
        // PASS 2: Face-based grass sampling
        // For each triangle where ALL 3 vertices have grass color (brightness < 0.5),
        // sample random points across the triangle surface using barycentric coordinates.
        // =====================================================================
        const index = geometry.index;
        if (index) {
            const cfg = GRASS_CONFIG;
            let faceGrassCount = 0;
            let qualifyingFaces = 0;
            const triangleCount = index.count / 3;

            // Reusable vectors to reduce allocations
            const v0Local = new THREE.Vector3();
            const v1Local = new THREE.Vector3();
            const v2Local = new THREE.Vector3();
            const n0Local = new THREE.Vector3();
            const n1Local = new THREE.Vector3();
            const n2Local = new THREE.Vector3();
            const edge1 = new THREE.Vector3();
            const edge2 = new THREE.Vector3();
            const crossVec = new THREE.Vector3();

            for (let f = 0; f < triangleCount; f++) {
                const i0 = index.getX(f * 3);
                const i1 = index.getX(f * 3 + 1);
                const i2 = index.getX(f * 3 + 2);

                // Check if ALL 3 vertices of this triangle have grass color
                const b0 = this.getVertexBrightness(grassAttr, i0);
                const b1 = this.getVertexBrightness(grassAttr, i1);
                const b2 = this.getVertexBrightness(grassAttr, i2);

                if (b0 >= 0.5 || b1 >= 0.5 || b2 >= 0.5) continue;

                qualifyingFaces++;

                // Get vertex positions in world space
                v0Local.set(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0));
                v1Local.set(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1));
                v2Local.set(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2));

                const v0World = v0Local.clone().applyMatrix4(worldMatrix);
                const v1World = v1Local.clone().applyMatrix4(worldMatrix);
                const v2World = v2Local.clone().applyMatrix4(worldMatrix);

                // Get vertex normals in world space
                n0Local.set(normalAttr.getX(i0), normalAttr.getY(i0), normalAttr.getZ(i0));
                n1Local.set(normalAttr.getX(i1), normalAttr.getY(i1), normalAttr.getZ(i1));
                n2Local.set(normalAttr.getX(i2), normalAttr.getY(i2), normalAttr.getZ(i2));

                const n0World = n0Local.clone().applyMatrix3(normalMatrix).normalize();
                const n1World = n1Local.clone().applyMatrix3(normalMatrix).normalize();
                const n2World = n2Local.clone().applyMatrix3(normalMatrix).normalize();

                // Calculate triangle area in world space using cross product
                edge1.subVectors(v1World, v0World);
                edge2.subVectors(v2World, v0World);
                crossVec.crossVectors(edge1, edge2);
                const area = 0.5 * crossVec.length();

                // Average weight from the 3 vertices (darker = more grass)
                const avgWeight = ((1.0 - b0) + (1.0 - b1) + (1.0 - b2)) / 3.0;

                // Number of blades proportional to area
                const rawCount = Math.round(area * cfg.bladesPerSquareUnit);
                const bladeCount = Math.min(Math.max(1, rawCount), cfg.maxBladesPerFace);

                for (let b = 0; b < bladeCount; b++) {
                    // Random barycentric coordinates for uniform sampling within triangle
                    let u = Math.random();
                    let v = Math.random();
                    if (u + v > 1.0) {
                        u = 1.0 - u;
                        v = 1.0 - v;
                    }
                    const w = 1.0 - u - v;

                    // Interpolate position: P = w*v0 + u*v1 + v*v2
                    const px = w * v0World.x + u * v1World.x + v * v2World.x;
                    const py = w * v0World.y + u * v1World.y + v * v2World.y;
                    const pz = w * v0World.z + u * v1World.z + v * v2World.z;

                    // Interpolate normal: N = w*n0 + u*n1 + v*n2
                    const nx = w * n0World.x + u * n1World.x + v * n2World.x;
                    const ny = w * n0World.y + u * n1World.y + v * n2World.y;
                    const nz = w * n0World.z + u * n1World.z + v * n2World.z;
                    const interpNormal = new THREE.Vector3(nx, ny, nz).normalize();

                    points.push({
                        position: new THREE.Vector3(px, py, pz),
                        normal: interpNormal,
                        weight: avgWeight,
                    });
                    faceGrassCount++;
                }
            }

            console.log(`Face-based sampling: ${qualifyingFaces} qualifying faces, ${faceGrassCount} additional grass points`);
        } else {
            console.warn('Geometry has no index buffer, skipping face-based grass sampling');
        }

        console.log(`Total grass spawn points: ${points.length} (${vertexPointCount} vertex + ${points.length - vertexPointCount} face-sampled)`);
        return points;
    }

    /**
     * Create instanced grass mesh from spawn points
     */
    private createGrassMesh(points: Array<{ position: THREE.Vector3; normal: THREE.Vector3; weight: number }>): THREE.Mesh | null {
        if (points.length === 0) {
            console.warn('No grass points found!');
            return null;
        }

        const cfg = GRASS_CONFIG;
        const bladeGeom = this.createBladeGeometry(cfg.bladeWidth, cfg.bladeHeight, 4);

        // First pass: determine random blade count per vertex
        const bladeCounts: number[] = [];
        let totalBlades = 0;
        for (const point of points) {
            // Random density: between 30% and 100% of max blades per vertex
            const density = 0.3 + Math.random() * 0.7;
            const count = Math.max(1, Math.round(cfg.bladesPerVertex * density));
            bladeCounts.push(count);
            totalBlades += count;
        }

        console.log(`Creating ${totalBlades} grass blades (random density)`);

        // Instance attributes
        const offsets = new Float32Array(totalBlades * 3);
        const angles = new Float32Array(totalBlades);
        const heights = new Float32Array(totalBlades);
        const normals = new Float32Array(totalBlades * 3);

        let idx = 0;
        for (let p = 0; p < points.length; p++) {
            const point = points[p];
            const bladeCount = bladeCounts[p];

            for (let b = 0; b < bladeCount; b++) {
                // Spread blades randomly around the vertex with sqrt for uniform disk distribution
                const randAngle = Math.random() * Math.PI * 2;
                const randDist = Math.sqrt(Math.random()) * cfg.spreadRadius;
                const ox = Math.cos(randAngle) * randDist;
                const oz = Math.sin(randAngle) * randDist;

                offsets[idx * 3]     = point.position.x + ox;
                offsets[idx * 3 + 1] = point.position.y;
                offsets[idx * 3 + 2] = point.position.z + oz;

                angles[idx] = Math.random() * Math.PI * 2;
                heights[idx] = cfg.bladeHeight + (Math.random() - 0.5) * 2.0 * cfg.bladeHeightVariation;

                normals[idx * 3]     = point.normal.x;
                normals[idx * 3 + 1] = point.normal.y;
                normals[idx * 3 + 2] = point.normal.z;

                idx++;
            }
        }

        // Create InstancedBufferGeometry
        const instancedGeom = new THREE.InstancedBufferGeometry();
        instancedGeom.index = bladeGeom.index;
        instancedGeom.setAttribute('position', bladeGeom.getAttribute('position'));

        instancedGeom.setAttribute('instanceOffset', new THREE.InstancedBufferAttribute(offsets, 3));
        instancedGeom.setAttribute('instanceAngle', new THREE.InstancedBufferAttribute(angles, 1));
        instancedGeom.setAttribute('instanceHeight', new THREE.InstancedBufferAttribute(heights, 1));
        instancedGeom.setAttribute('instanceNormal', new THREE.InstancedBufferAttribute(normals, 3));

        // Interactor positions uniform array
        const interactorPositions: THREE.Vector3[] = [];
        for (let i = 0; i < MAX_INTERACTORS; i++) {
            interactorPositions.push(new THREE.Vector3(9999, 9999, 9999));
        }

        const material = new THREE.ShaderMaterial({
            vertexShader: grassVertexShader,
            fragmentShader: grassFragmentShader,
            uniforms: {
                uTime: { value: 0 },
                uWindStrength: { value: cfg.windStrength },
                uWindSpeed: { value: cfg.windSpeed },
                uInteractionRadius: { value: cfg.interactionRadius },
                uInteractionStrength: { value: cfg.interactionStrength },
                uInteractors: { value: interactorPositions },
                uInteractorCount: { value: 0 },
                uColorBase: { value: cfg.colorBase },
                uColorTip: { value: cfg.colorTip },
                uLightDir: { value: new THREE.Vector3(8, 12, 6).normalize() },
                uLightColor: { value: new THREE.Color(0xfff4e6) },
                uAmbientStrength: { value: 0.4 },
            },
            side: THREE.DoubleSide,
            transparent: true,
            depthWrite: true,
        });

        const grassMesh = new THREE.Mesh(instancedGeom, material);
        grassMesh.frustumCulled = false;
        return grassMesh;
    }

    /**
     * Collect all scene objects that should interact with grass
     */
    private collectInteractors(model: THREE.Group, grassMeshRef: THREE.Mesh): THREE.Object3D[] {
        const interactors: THREE.Object3D[] = [];
        model.traverse((child) => {
            if ((child as THREE.Mesh).isMesh && child !== grassMeshRef && child.name !== 'Mesh_0') {
                interactors.push(child);
            }
        });
        console.log(`Found ${interactors.length} interactor objects`);
        return interactors;
    }

    /**
     * Initialize the grass system from a loaded model
     */
    public init(model: THREE.Group): void {
        // Debug: list all meshes in scene
        console.log('--- All meshes in GLB ---');
        model.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const attrs = Object.keys((child as THREE.Mesh).geometry.attributes);
                const hasColor = attrs.some(a => a.toLowerCase().includes('color'));
                console.log(`  "${child.name}" - attributes: [${attrs.join(', ')}] ${hasColor ? '(HAS VERTEX COLORS)' : ''}`);
            }
        });

        let targetMesh: THREE.Mesh | null = null as THREE.Mesh | null;

        // 1. Try exact name match
        model.traverse((child) => {
            if ((child as THREE.Mesh).isMesh && child.name === 'Mesh_0') {
                targetMesh = child as THREE.Mesh;
            }
        });

        // 2. Fallback: any mesh with vertex color attributes
        if (!targetMesh) {
            model.traverse((child) => {
                if ((child as THREE.Mesh).isMesh && !targetMesh) {
                    const attrs = Object.keys((child as THREE.Mesh).geometry.attributes);
                    const hasColor = attrs.some(a => a.toLowerCase().includes('color'));
                    if (hasColor) {
                        targetMesh = child as THREE.Mesh;
                        console.log(`Mesh_0 not found, using "${child.name}" which has vertex colors`);
                    }
                }
            });
        }

        if (targetMesh) {
            console.log(`Target mesh: "${targetMesh.name}"`);

            const grassPoints = this.extractGrassPoints(targetMesh);
            if (grassPoints.length > 0) {
                this.grassMesh = this.createGrassMesh(grassPoints);
                if (this.grassMesh) {
                    console.log('Grass system initialized');
                }
            }

            // Collect animated/movable objects for interaction
            if (this.grassMesh) {
                this.interactors = this.collectInteractors(model, this.grassMesh);
            }
        } else {
            console.warn('No mesh with vertex colors found in the scene');
        }
    }

    /**
     * Get the grass mesh (to add to scene)
     */
    public getMesh(): THREE.Mesh | null {
        return this.grassMesh;
    }

    /**
     * Update grass shader uniforms (call each frame)
     */
    public update(elapsed: number): void {
        if (!this.grassMesh) return;

        const material = this.grassMesh.material as THREE.ShaderMaterial;
        material.uniforms.uTime.value = elapsed;

        // Update interactor positions (animated objects near grass)
        const positions = material.uniforms.uInteractors.value as THREE.Vector3[];
        const count = Math.min(this.interactors.length, MAX_INTERACTORS);
        for (let i = 0; i < count; i++) {
            this.interactors[i].getWorldPosition(this._interactorWorldPos);
            positions[i].copy(this._interactorWorldPos);
        }
        material.uniforms.uInteractorCount.value = count;
    }

    /**
     * Update grass lighting to match the day-night cycle
     */
    public updateLighting(lightDir: THREE.Vector3, lightColor: THREE.Color, ambientStrength: number): void {
        if (!this.grassMesh) return;
        const material = this.grassMesh.material as THREE.ShaderMaterial;
        material.uniforms.uLightDir.value.copy(lightDir);
        material.uniforms.uLightColor.value.copy(lightColor);
        material.uniforms.uAmbientStrength.value = ambientStrength;
    }

    /**
     * Set the player position so grass bends around player
     */
    public setPlayerPosition(pos: THREE.Vector3): void {
        if (!this.grassMesh) return;

        const material = this.grassMesh.material as THREE.ShaderMaterial;
        const positions = material.uniforms.uInteractors.value as THREE.Vector3[];

        // Set player as first interactor
        positions[0].copy(pos);

        // Ensure interactor count is at least 1
        if (material.uniforms.uInteractorCount.value < 1) {
            material.uniforms.uInteractorCount.value = 1;
        }
    }

    /**
     * Dispose of grass mesh and resources
     */
    public dispose(): void {
        if (this.grassMesh) {
            const geometry = this.grassMesh.geometry;
            const material = this.grassMesh.material as THREE.ShaderMaterial;

            geometry.dispose();
            material.dispose();

            this.grassMesh = null;
        }
        this.interactors = [];
    }
}
