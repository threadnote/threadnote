import React, {useEffect, useMemo, useRef, useState} from 'react';
import * as THREE from 'three';
import {GRAPH_PALETTE} from './graph/model.js';

export interface HomeAttentionInput {
  readonly coverage?: string;
  readonly findings?: number;
  readonly decisions?: number;
  readonly healthCoverage?: string;
  readonly memories?: number;
  readonly outcomes?: number;
  readonly pending?: number;
  readonly scanned?: number;
}

export interface HomeAttentionNode {
  readonly action: 'context' | 'context-health' | 'memory' | 'reviews';
  readonly detail: string;
  readonly id: 'context' | 'reviews' | 'health' | 'outcomes';
  readonly kicker: string;
  readonly label: string;
  readonly status: 'attention' | 'available' | 'clear' | 'unavailable';
  readonly value: string;
}

const FLOW_POSITIONS = {
  context: new THREE.Vector3(0.14, 0.5, 0),
  reviews: new THREE.Vector3(0.46, 0.25, 0),
  health: new THREE.Vector3(0.46, 0.75, 0),
  outcomes: new THREE.Vector3(0.84, 0.5, 0),
} as const;

const FLOW_EDGES = [
  {bend: -0.035, from: 'context', to: 'reviews'},
  {bend: 0.035, from: 'context', to: 'health'},
  {bend: 0.035, from: 'reviews', to: 'outcomes'},
  {bend: -0.035, from: 'health', to: 'outcomes'},
] as const;

const FLOW_COLORS = {
  context: GRAPH_PALETTE[0],
  health: GRAPH_PALETTE[1],
  outcomes: GRAPH_PALETTE[2],
  reviews: GRAPH_PALETTE[3],
} as const;

export function buildHomeAttentionModel(input: HomeAttentionInput): readonly HomeAttentionNode[] {
  const memories = safeCount(input.memories);
  const pending = safeCount(input.pending);
  const findings = safeCount(input.decisions ?? input.findings);
  const outcomes = safeCount(input.outcomes);
  return [
    {
      action: 'memory',
      detail: contextDetail(input),
      id: 'context',
      kicker: 'Context base',
      label: 'active memories',
      status: memories === undefined ? 'unavailable' : 'available',
      value: formatCount(memories),
    },
    {
      action: 'reviews',
      detail:
        pending === undefined ? 'Review evidence unavailable' : pending === 0 ? 'Queue is clear' : 'Needs a decision',
      id: 'reviews',
      kicker: 'Review queue',
      label: pending === 1 ? 'pending decision' : 'pending decisions',
      status: countStatus(pending),
      value: formatCount(pending),
    },
    {
      action: 'context-health',
      detail:
        findings === undefined
          ? 'Health evidence unavailable'
          : findings === 0
            ? input.healthCoverage === 'partial' || input.healthCoverage === 'unavailable'
              ? 'No decisions; evidence checks incomplete'
              : 'No actionable findings'
            : 'Findings to inspect or repair',
      id: 'health',
      kicker: 'Context quality',
      label:
        input.decisions === undefined
          ? findings === 1
            ? 'health finding'
            : 'health findings'
          : findings === 1
            ? 'memory needs you'
            : 'memories need you',
      status:
        input.decisions !== undefined &&
        findings === 0 &&
        (input.healthCoverage === 'partial' || input.healthCoverage === 'unavailable')
          ? 'unavailable'
          : countStatus(findings),
      value: formatCount(findings),
    },
    {
      action: 'context',
      detail: outcomes === undefined ? 'Outcome evidence unavailable' : 'Applied, useful, or reviewed',
      id: 'outcomes',
      kicker: 'Last 30 days',
      label: outcomes === 1 ? 'recent outcome' : 'recent outcomes',
      status: outcomes === undefined ? 'unavailable' : 'available',
      value: formatCount(outcomes),
    },
  ];
}

export function HomeAttentionFlow({
  input,
  onOpen,
}: {
  readonly input: HomeAttentionInput;
  readonly onOpen: (target: HomeAttentionNode['action']) => void;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const nodes = useMemo(
    () => buildHomeAttentionModel(input),
    [
      input.coverage,
      input.healthCoverage,
      input.decisions,
      input.findings,
      input.memories,
      input.outcomes,
      input.pending,
      input.scanned,
    ],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({alpha: true, antialias: true, canvas, powerPreference: 'low-power'});
      setWebglUnavailable(false);
    } catch {
      setWebglUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);
    const flows = FLOW_EDGES.map((edge, edgeIndex) => createFlow(scene, edge, edgeIndex));
    let frame = 0;
    let visible = !document.hidden;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = reducedMotion.matches;

    const renderAt = (phase: number): void => {
      for (const flow of flows) {
        for (let index = 0; index < flow.particleCount; index += 1) {
          const point = flow.curve.getPoint((phase * flow.speed + index / flow.particleCount) % 1);
          flow.positions.setXYZ(index, point.x, point.y, point.z);
        }
        flow.positions.needsUpdate = true;
      }
      renderer.render(scene, camera);
    };
    const resize = (): void => {
      const bounds = container.getBoundingClientRect();
      renderer.setSize(Math.max(1, bounds.width), Math.max(1, bounds.height), false);
      renderAt(reduced ? 0.36 : performance.now() * 0.00012);
    };
    const animate = (now: number): void => {
      if (!visible || reduced) return;
      renderAt(now * 0.00012);
      frame = window.requestAnimationFrame(animate);
    };
    const onVisibility = (): void => {
      visible = !document.hidden;
      window.cancelAnimationFrame(frame);
      if (visible && !reduced) frame = window.requestAnimationFrame(animate);
    };
    const onMotion = (): void => {
      reduced = reducedMotion.matches;
      window.cancelAnimationFrame(frame);
      renderAt(0.36);
      if (!reduced && visible) frame = window.requestAnimationFrame(animate);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    document.addEventListener('visibilitychange', onVisibility);
    reducedMotion.addEventListener('change', onMotion);
    resize();
    if (!reduced && visible) frame = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reducedMotion.removeEventListener('change', onMotion);
      for (const flow of flows) {
        flow.line.geometry.dispose();
        flow.line.material.dispose();
        flow.particles.geometry.dispose();
        flow.particles.material.dispose();
      }
      renderer.dispose();
    };
  }, [nodes]);

  return (
    <section className="home-attention-flow" aria-label="Live project attention flow">
      <header className="home-attention-flow-head">
        <div>
          <p className="eyebrow">Live project map</p>
          <h3>Where context needs attention</h3>
          <p>Follow current context through review and quality work into recent outcomes.</p>
        </div>
      </header>
      <div className="home-attention-flow-scene" ref={containerRef}>
        <canvas aria-hidden="true" ref={canvasRef} />
        {nodes.map(node => (
          <button
            aria-label={`Open ${node.kicker}: ${node.value} ${node.label}`}
            className={`home-flow-node is-${node.id} is-${node.status}`}
            key={node.id}
            onClick={() => onOpen(node.action)}
            type="button"
          >
            <span className="home-flow-kicker">
              <i aria-hidden="true" /> {node.kicker}
            </span>
            <span className="home-flow-metric">
              <strong>{node.value}</strong>
              <span className="home-flow-label">{node.label}</span>
            </span>
            <small>{node.detail}</small>
            <span className="home-flow-action" aria-hidden="true">
              Open <b>→</b>
            </span>
          </button>
        ))}
        {webglUnavailable ? (
          <p className="home-attention-flow-fallback">Motion unavailable. Live values and actions remain available.</p>
        ) : null}
      </div>
    </section>
  );
}

function createFlow(scene: THREE.Scene, edge: (typeof FLOW_EDGES)[number], edgeIndex: number) {
  const start = FLOW_POSITIONS[edge.from];
  const end = FLOW_POSITIONS[edge.to];
  const control = start.clone().lerp(end, 0.5);
  control.y += edge.bend;
  const curve = new THREE.QuadraticBezierCurve3(start, control, end);
  const lineMaterial = new THREE.LineBasicMaterial({
    blending: THREE.AdditiveBlending,
    color: FLOW_COLORS[edge.to],
    opacity: 0.34,
    transparent: true,
  });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)), lineMaterial);
  scene.add(line);
  const particleCount = 4;
  const positions = new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3);
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', positions);
  const particleMaterial = new THREE.PointsMaterial({
    blending: THREE.AdditiveBlending,
    color: FLOW_COLORS[edge.to],
    opacity: 0.9,
    size: 5,
    sizeAttenuation: false,
    transparent: true,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  scene.add(particles);
  return {curve, line, particleCount, particles, positions, speed: 0.7 + edgeIndex * 0.08};
}

function contextDetail(input: HomeAttentionInput): string {
  const scanned = safeCount(input.scanned);
  const coverage = input.coverage && input.coverage !== 'unavailable' ? `${input.coverage} coverage` : undefined;
  if (scanned !== undefined && coverage) return `${scanned.toLocaleString()} scanned · ${coverage}`;
  if (scanned !== undefined) return `${scanned.toLocaleString()} records scanned`;
  return coverage ?? 'Inventory evidence unavailable';
}

function countStatus(value: number | undefined): HomeAttentionNode['status'] {
  return value === undefined ? 'unavailable' : value === 0 ? 'clear' : 'attention';
}

function formatCount(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : value.toLocaleString();
}

function safeCount(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.floor(value));
}
