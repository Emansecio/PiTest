import { useEffect, useMemo, useRef, useState } from "react";
import { WORLD_MAP } from "./worldMap";

// Density ramp for shading (from dim to bright)
// We only use dots/circles to mimic the Amp CLI aesthetic.
const LAND_RAMP = ["·", "∙", "•", "●"];
const OCEAN_RAMP = [" ", "·", "∙", "•"];

interface GlobeProps {
  /** Width in characters */
  cols?: number;
  /** Height in characters */
  rows?: number;
  /** Degrees per frame */
  rotationSpeed?: number;
  /** Milliseconds per frame */
  frameMs?: number;
  /** Axial tilt in degrees */
  tilt?: number;
}

// Sample the world map at given latitude/longitude (both in degrees).
// lat: -90 (south) .. 90 (north). lon: -180 .. 180
function sampleLand(latDeg: number, lonDeg: number): boolean {
  const rows = WORLD_MAP.length;
  const cols = WORLD_MAP[0].length;
  // Convert lat: 90 -> row 0, -90 -> row rows-1
  const rowF = ((90 - latDeg) / 180) * (rows - 1);
  // Convert lon: -180 -> col 0, 180 -> col cols-1 (wrap)
  let lonNorm = ((lonDeg + 180) % 360 + 360) % 360; // 0..360
  const colF = (lonNorm / 360) * cols;

  const r = Math.max(0, Math.min(rows - 1, Math.round(rowF)));
  const c = Math.floor(colF) % cols;
  return WORLD_MAP[r][c] === "#";
}

export default function Globe({
  cols = 44,
  rows = 22,
  rotationSpeed = 2.2,
  frameMs = 90,
  tilt = 18,
}: GlobeProps) {
  const [longitude, setLongitude] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(performance.now());

  useEffect(() => {
    const tick = (now: number) => {
      if (now - lastRef.current >= frameMs) {
        lastRef.current = now;
        setLongitude((l) => (l + rotationSpeed) % 360);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [frameMs, rotationSpeed]);

  const frame = useMemo(() => {
    // Character cells aren't square — they're roughly 2:1 (tall). Compensate
    // so the globe renders as a circle rather than an ellipse.
    const charAspect = 2.0;
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    // Sphere radius in "normalized" units — leave a little padding.
    const R = Math.min(cx / 1, cy);

    // Light source direction (unit vector in view space).
    // Slightly upper-right so the highlight looks natural.
    const lx = 0.55;
    const ly = -0.45;
    const lz = 0.7;
    const lLen = Math.hypot(lx, ly, lz);
    const Lx = lx / lLen, Ly = ly / lLen, Lz = lz / lLen;

    const tiltRad = (tilt * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);

    const cells: { char: string; color: string }[][] = [];

    for (let y = 0; y < rows; y++) {
      const row: { char: string; color: string }[] = [];
      for (let x = 0; x < cols; x++) {
        // Convert to sphere-space coords (aspect corrected).
        const nx = (x - cx) / R;
        const ny = ((y - cy) * charAspect) / R;
        const r2 = nx * nx + ny * ny;
        if (r2 > 1.0) {
          row.push({ char: " ", color: "" });
          continue;
        }
        const nz = Math.sqrt(1 - r2); // front-facing point on unit sphere

        // Un-tilt (rotate around X axis by -tilt) to get axis-aligned coords
        // where +Y is the north pole.
        // View coords: (nx, ny, nz). Tilt rotates around X axis.
        // We need inverse: rotate by -tilt around X.
        const py = ny * cosT - nz * sinT;
        const pz = ny * sinT + nz * cosT;
        const px = nx;

        // Now (px, py, pz) is a point on the unit sphere in an axis-aligned
        // frame (Y is north pole). Compute lat/lon.
        // Clamp for safety
        const yClamped = Math.max(-1, Math.min(1, -py)); // invert because screen Y grows down
        const latDeg = (Math.asin(yClamped) * 180) / Math.PI;
        // Longitude around Y axis: atan2(px, pz) gives 0 at +Z (facing viewer).
        const lonPoint = Math.atan2(px, pz); // radians
        const lonDeg = ((lonPoint * 180) / Math.PI) - longitude;

        const isLand = sampleLand(latDeg, lonDeg);

        // Compute lighting: dot(normal, light). Normal in *view* space = (nx, ny, nz).
        const dot = nx * Lx + ny * Ly + nz * Lz;
        // Add small ambient
        const shade = Math.max(0, Math.min(1, dot * 0.85 + 0.25));

        // Fresnel-like edge fade: cells near the limb get dimmer.
        const edge = nz; // 0 at limb, 1 at center
        const brightness = shade * (0.35 + 0.65 * edge);

        let char: string;
        let color: string;
        if (isLand) {
          const idx = Math.min(
            LAND_RAMP.length - 1,
            Math.floor(brightness * LAND_RAMP.length),
          );
          char = LAND_RAMP[idx];
          // Green ramp (matches Amp aesthetic)
          const greens = ["#1f5d4a", "#2f8a63", "#3fbf7f", "#5fe3a1"];
          color = greens[idx];
        } else {
          const idx = Math.min(
            OCEAN_RAMP.length - 1,
            Math.floor(brightness * OCEAN_RAMP.length),
          );
          char = OCEAN_RAMP[idx];
          // Teal/cyan ramp for ocean
          const teals = ["#0e2a33", "#155e6b", "#1f8a94", "#2fb8b8"];
          color = teals[idx];
        }

        row.push({ char, color });
      }
      cells.push(row);
    }
    return cells;
  }, [longitude, cols, rows, tilt]);

  return (
    <pre
      className="font-mono leading-[1] text-[14px] select-none"
      style={{ letterSpacing: "0.05em" }}
      aria-hidden
    >
      {frame.map((row, y) => (
        <div key={y} className="whitespace-pre">
          {row.map((cell, x) =>
            cell.char === " " ? (
              <span key={x}>{"\u00A0"}</span>
            ) : (
              <span key={x} style={{ color: cell.color }}>
                {cell.char}
              </span>
            ),
          )}
        </div>
      ))}
    </pre>
  );
}
