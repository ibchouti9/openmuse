import { useEffect, useRef } from "react";

interface MusePrism3DProps {
  size?: number;
  interactive?: boolean;
  intensity?: "gentle" | "vibrant";
  className?: string;
}

export default function MusePrism3D({
  size = 180,
  interactive = true,
  intensity = "vibrant",
  className = "",
}: MusePrism3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    rotX: 0.3,
    rotY: 0.4,
    rotZ: 0.1,
    targetRotX: 0.3,
    targetRotY: 0.4,
    isHovering: false,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    // Define 3D Polyhedral crystalline vertices (Octahedron + Stellate spikes)
    const vertices: [number, number, number][] = [
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      // Stellate core nodes
      [0.6, 0.6, 0.6],
      [-0.6, 0.6, 0.6],
      [0.6, -0.6, 0.6],
      [-0.6, -0.6, 0.6],
      [0.6, 0.6, -0.6],
      [-0.6, 0.6, -0.6],
      [0.6, -0.6, -0.6],
      [-0.6, -0.6, -0.6],
    ];

    // Connect edges
    const edges: [number, number][] = [
      [0, 2], [0, 3], [0, 4], [0, 5],
      [1, 2], [1, 3], [1, 4], [1, 5],
      [2, 4], [4, 3], [3, 5], [5, 2],
      // Stellate connections
      [0, 6], [0, 7], [0, 10], [0, 11],
      [1, 8], [1, 9], [1, 12], [1, 13],
      [4, 6], [4, 7], [4, 8], [4, 9],
      [5, 10], [5, 11], [5, 12], [5, 13],
      [6, 8], [7, 9], [10, 12], [11, 13],
    ];

    // Floating orbital particle ring
    const particles = Array.from({ length: 36 }, (_, i) => {
      const angle = (i / 36) * Math.PI * 2;
      const radius = 1.35 + Math.sin(i * 3) * 0.15;
      return {
        x: Math.cos(angle) * radius,
        y: (Math.random() - 0.5) * 0.4,
        z: Math.sin(angle) * radius,
        baseAngle: angle,
        speed: 0.008 + (i % 3) * 0.003,
        size: 1.5 + (i % 3),
        hue: i % 2 === 0 ? 195 : 265, // Cyan & Electric Violet
      };
    });

    function project(p: [number, number, number], rotX: number, rotY: number, rotZ: number, scale: number): { x: number; y: number; z: number } {
      let [x, y, z] = p;

      // Rotate Y
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;

      // Rotate X
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);
      const y2 = y * cosX - z1 * sinX;
      const z2 = y * sinX + z1 * cosX;

      // Rotate Z
      const cosZ = Math.cos(rotZ);
      const sinZ = Math.sin(rotZ);
      const x3 = x1 * cosZ - y2 * sinZ;
      const y3 = x1 * sinZ + y2 * cosZ;

      // Perspective projection
      const fov = 3.2;
      const fovFactor = fov / (fov + z2);

      const cx = (size * dpr) / 2;
      const cy = (size * dpr) / 2;

      return {
        x: cx + x3 * scale * fovFactor,
        y: cy + y3 * scale * fovFactor,
        z: z2,
      };
    }

    let time = 0;

    function render() {
      if (!ctx || !canvas) return;
      time += 0.016;
      const state = stateRef.current;

      // Smooth damping towards mouse position if hovered, else gentle auto rotation
      if (state.isHovering) {
        state.rotX += (state.targetRotX - state.rotX) * 0.08;
        state.rotY += (state.targetRotY - state.rotY) * 0.08;
      } else {
        state.rotY += 0.01;
        state.rotX = 0.25 + Math.sin(time * 0.6) * 0.15;
      }
      state.rotZ = Math.sin(time * 0.3) * 0.1;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const scale = (size * dpr) * 0.3;

      // 1. Draw glowing background radial aura
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const auraGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 1.5);
      const alpha = intensity === "vibrant" ? 0.35 : 0.18;
      auraGradient.addColorStop(0, `rgba(56, 189, 248, ${alpha * 0.7})`);
      auraGradient.addColorStop(0.35, `rgba(99, 102, 241, ${alpha * 0.5})`);
      auraGradient.addColorStop(0.7, `rgba(168, 85, 247, ${alpha * 0.2})`);
      auraGradient.addColorStop(1, "rgba(9, 13, 18, 0)");
      ctx.fillStyle = auraGradient;
      ctx.beginPath();
      ctx.arc(cx, cy, scale * 1.5, 0, Math.PI * 2);
      ctx.fill();

      // 2. Project vertices
      const projected = vertices.map((v) => {
        // Breathe slightly
        const breathe = 1 + Math.sin(time * 2.5) * 0.04;
        const scaledV: [number, number, number] = [v[0] * breathe, v[1] * breathe, v[2] * breathe];
        return project(scaledV, state.rotX, state.rotY, state.rotZ, scale);
      });

      // 3. Draw translucent facets / faces (depth-sorted)
      const faces: [number, number, number][] = [
        [0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2],
        [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5],
      ];

      const sortedFaces = faces.map(([a, b, c]) => {
        const pa = projected[a];
        const pb = projected[b];
        const pc = projected[c];
        const avgZ = (pa.z + pb.z + pc.z) / 3;
        return { a: pa, b: pb, c: pc, z: avgZ };
      }).sort((f1, f2) => f1.z - f2.z);

      for (const face of sortedFaces) {
        ctx.beginPath();
        ctx.moveTo(face.a.x, face.a.y);
        ctx.lineTo(face.b.x, face.b.y);
        ctx.lineTo(face.c.x, face.c.y);
        ctx.closePath();

        const zNorm = (face.z + 1.2) / 2.4; // 0 to 1
        const faceAlpha = Math.max(0.04, Math.min(0.22, 0.05 + zNorm * 0.16));
        const gradient = ctx.createLinearGradient(face.a.x, face.a.y, face.c.x, face.c.y);
        gradient.addColorStop(0, `rgba(56, 189, 248, ${faceAlpha * 1.3})`);
        gradient.addColorStop(1, `rgba(139, 92, 246, ${faceAlpha * 0.8})`);
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // 4. Draw Edges with glowing gradient
      for (const [i1, i2] of edges) {
        const p1 = projected[i1];
        const p2 = projected[i2];
        const avgZ = (p1.z + p2.z) / 2;
        const edgeAlpha = Math.max(0.2, Math.min(0.9, 0.4 + avgZ * 0.4));

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = `rgba(56, 189, 248, ${edgeAlpha})`;
        ctx.lineWidth = (1 + Math.max(0, avgZ) * 1.2) * dpr;
        ctx.stroke();
      }

      // 5. Draw Glowing Vertices
      for (const p of projected) {
        const pointAlpha = Math.max(0.3, Math.min(1, 0.5 + p.z * 0.5));
        ctx.beginPath();
        const ptRadius = (2.2 + Math.max(0, p.z) * 1.5) * dpr;
        ctx.arc(p.x, p.y, ptRadius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(224, 242, 254, ${pointAlpha})`;
        ctx.shadowColor = "#38bdf8";
        ctx.shadowBlur = 10 * dpr;
        ctx.fill();
        ctx.shadowBlur = 0; // reset
      }

      // 6. Draw Orbiting Particles
      for (const pt of particles) {
        pt.baseAngle += pt.speed;
        const currentRadius = 1.35 + Math.sin(time + pt.baseAngle * 2) * 0.15;
        const px = Math.cos(pt.baseAngle) * currentRadius;
        const py = pt.y + Math.sin(time * 1.5 + pt.baseAngle) * 0.25;
        const pz = Math.sin(pt.baseAngle) * currentRadius;

        const proj = project([px, py, pz], state.rotX * 0.8, state.rotY * 0.8, state.rotZ, scale * 1.05);

        const pAlpha = Math.max(0.15, Math.min(0.9, 0.4 + proj.z * 0.4));
        ctx.beginPath();
        ctx.arc(proj.x, proj.y, pt.size * dpr * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = pt.hue === 195
          ? `rgba(56, 189, 248, ${pAlpha})`
          : `rgba(168, 85, 247, ${pAlpha})`;
        ctx.shadowColor = pt.hue === 195 ? "#38bdf8" : "#a855f7";
        ctx.shadowBlur = 6 * dpr;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      animId = requestAnimationFrame(render);
    }

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [size, intensity]);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5; // -0.5 to 0.5
    const y = (e.clientY - rect.top) / rect.height - 0.5; // -0.5 to 0.5

    stateRef.current.isHovering = true;
    stateRef.current.targetRotY = x * Math.PI * 1.8;
    stateRef.current.targetRotX = -y * Math.PI * 1.2;
  }

  function handleMouseLeave() {
    stateRef.current.isHovering = false;
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className={`muse-prism-canvas ${className}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    />
  );
}
