import {Array as EffectArray} from 'effect';
import {useEffect, useRef, useState} from 'react';
import type {Line, Mesh, MeshBasicMaterial, MeshStandardMaterial, WebGLRenderer} from 'three';

import {
  managerDemoEdges,
  managerDemoNodes,
  type ManagerDemoGraphEdge,
  type ManagerDemoGraphNode,
  type ManagerDemoTone,
} from '../content/managerDemo';

const NODE_COLORS: Readonly<Record<ManagerDemoTone, number>> = {
  amber: 0xffb86b,
  azure: 0x7aa2ff,
  rose: 0xff7ab8,
  teal: 0x67e8c7,
  violet: 0xc08cff,
};

interface Disposable {
  dispose(): void;
}

export interface ManagerGraphSceneProps {
  readonly project: string;
  readonly relation: ManagerDemoGraphEdge['relation'] | 'all';
  readonly selectedNodeId: string;
}

type ManagerGraphSceneState = ManagerGraphSceneProps;

function describeNode(node: ManagerDemoGraphNode): string {
  return `${node.label}, ${node.kind}, ${node.language}, ${node.connections} connections`;
}

export function ManagerGraphScene({project, relation, selectedNodeId}: ManagerGraphSceneProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestStateRef = useRef<ManagerGraphSceneState>({project, relation, selectedNodeId});
  const updateGraphStateRef = useRef<(state: ManagerGraphSceneState) => void>(() => {});
  const [rendering, setRendering] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  latestStateRef.current = {project, relation, selectedNodeId};

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let disposed = false;
    let frame = 0;
    let inViewport = true;
    let pageVisible = !document.hidden;
    let renderer: WebGLRenderer | undefined;
    const disposables: Disposable[] = [];
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionPreference.matches;
    let applyMotionPreference = (): void => {};
    const motionPreferenceChanged = (event: MediaQueryListEvent): void => {
      reducedMotion = event.matches;
      applyMotionPreference();
    };
    motionPreference.addEventListener('change', motionPreferenceChanged);
    let cleanup = (): void => {};

    const stop = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    void import('three')
      .then(THREE => {
        if (disposed) return;

        try {
          renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: true,
            canvas,
            powerPreference: 'low-power',
          });
        } catch {
          setRendering('unavailable');
          return;
        }

        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
        camera.position.set(0, 0, 12.5);

        const graph = new THREE.Group();
        graph.rotation.x = -0.06;
        graph.rotation.z = -0.02;
        scene.add(graph);

        const ambient = new THREE.AmbientLight(0xffffff, 1.5);
        const key = new THREE.PointLight(0x67e8c7, 16, 28);
        const fill = new THREE.PointLight(0x7aa2ff, 11, 24);
        key.position.set(-5, 4, 7);
        fill.position.set(5, -3, 6);
        scene.add(ambient, key, fill);

        const positions = new Map(
          EffectArray.map(managerDemoNodes, node => [node.id, new THREE.Vector3(node.x, node.y, node.z)] as const),
        );

        const edgeLines: {
          readonly edge: ManagerDemoGraphEdge;
          readonly line: Line;
        }[] = [];
        for (const edge of managerDemoEdges) {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) continue;

          const geometry = new THREE.BufferGeometry().setFromPoints([source, target]);
          const material = new THREE.LineBasicMaterial({
            color: edge.provenance === 'authoritative' ? 0x4c6a72 : 0x725e78,
            opacity: edge.provenance === 'authoritative' ? 0.68 : 0.4,
            transparent: true,
          });
          const line = new THREE.Line(geometry, material);
          graph.add(line);
          edgeLines.push({edge, line});
          disposables.push(geometry, material);
        }

        const nodeMeshes = new Map<
          string,
          {readonly material: MeshStandardMaterial; readonly mesh: Mesh; readonly node: ManagerDemoGraphNode}
        >();
        for (const node of managerDemoNodes) {
          const geometry = new THREE.SphereGeometry(0.2 + Math.min(node.connections, 18) * 0.008, 18, 14);
          const material = new THREE.MeshStandardMaterial({
            color: NODE_COLORS[node.tone],
            emissive: NODE_COLORS[node.tone],
            emissiveIntensity: 0.24,
            metalness: 0.12,
            roughness: 0.4,
          });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(node.x, node.y, node.z);
          graph.add(mesh);
          nodeMeshes.set(node.id, {material, mesh, node});
          disposables.push(geometry, material);
        }

        const haloGeometry = new THREE.RingGeometry(0.43, 0.48, 40);
        const haloMaterial: MeshBasicMaterial = new THREE.MeshBasicMaterial({
          color: 0x67e8c7,
          opacity: 0.52,
          side: THREE.DoubleSide,
          transparent: true,
        });
        const halo: Mesh = new THREE.Mesh(haloGeometry, haloMaterial);
        halo.visible = false;
        graph.add(halo);
        disposables.push(haloGeometry, haloMaterial);

        const resize = (): void => {
          if (!renderer || disposed) return;
          const width = Math.max(container.clientWidth, 1);
          const height = Math.max(container.clientHeight, 1);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
        };

        const render = (time: number): void => {
          frame = 0;
          if (!renderer || disposed || !inViewport || !pageVisible) return;
          if (!reducedMotion) {
            graph.rotation.y = Math.sin(time * 0.00018) * 0.09;
            graph.rotation.x = -0.06 + Math.cos(time * 0.00015) * 0.025;
          }
          renderer.render(scene, camera);
          if (!reducedMotion) frame = requestAnimationFrame(render);
        };

        const start = (): void => {
          if (frame || disposed || !inViewport || !pageVisible) return;
          frame = requestAnimationFrame(render);
        };
        applyMotionPreference = (): void => {
          if (reducedMotion) {
            stop();
            renderer?.render(scene, camera);
          } else {
            start();
          }
        };

        const visibilityChanged = (): void => {
          pageVisible = !document.hidden;
          if (pageVisible) start();
          else stop();
        };

        const updateGraphState = (state: ManagerGraphSceneState): void => {
          halo.visible = false;
          for (const [id, item] of nodeMeshes) {
            const visible = state.project === 'all' || item.node.project === state.project;
            const selected = id === state.selectedNodeId;
            item.mesh.visible = visible;
            item.mesh.scale.setScalar(selected ? 1.46 : 1);
            item.material.emissiveIntensity = selected ? 0.72 : 0.24;
            if (selected && visible) {
              halo.position.copy(item.mesh.position);
              haloMaterial.color.setHex(NODE_COLORS[item.node.tone]);
              halo.visible = true;
            }
          }
          for (const {edge, line} of edgeLines) {
            const sourceVisible =
              state.project === 'all' || nodeMeshes.get(edge.source)?.node.project === state.project;
            const targetVisible =
              state.project === 'all' || nodeMeshes.get(edge.target)?.node.project === state.project;
            line.visible =
              sourceVisible && targetVisible && (state.relation === 'all' || edge.relation === state.relation);
          }
          if (renderer && inViewport && pageVisible) renderer.render(scene, camera);
        };
        updateGraphStateRef.current = updateGraphState;
        updateGraphState(latestStateRef.current);

        const resizeObserver =
          'ResizeObserver' in window
            ? new ResizeObserver(resize)
            : {
                disconnect: () => window.removeEventListener('resize', resize),
                observe: () => window.addEventListener('resize', resize),
              };
        resizeObserver.observe(container);

        const intersectionObserver =
          'IntersectionObserver' in window
            ? new IntersectionObserver(
                entries => {
                  inViewport = entries[0]?.isIntersecting ?? false;
                  if (inViewport) start();
                  else stop();
                },
                {rootMargin: '80px'},
              )
            : undefined;
        intersectionObserver?.observe(container);
        document.addEventListener('visibilitychange', visibilityChanged);

        resize();
        setRendering('ready');
        start();

        const previousCleanup = cleanup;
        cleanup = (): void => {
          previousCleanup();
          resizeObserver.disconnect();
          intersectionObserver?.disconnect();
          document.removeEventListener('visibilitychange', visibilityChanged);
          if (updateGraphStateRef.current === updateGraphState) updateGraphStateRef.current = () => {};
        };
      })
      .catch(() => {
        if (!disposed) setRendering('unavailable');
      });

    return () => {
      disposed = true;
      stop();
      motionPreference.removeEventListener('change', motionPreferenceChanged);
      applyMotionPreference = () => {};
      cleanup();
      for (const disposable of disposables) disposable.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
  }, []);

  useEffect(() => {
    updateGraphStateRef.current({project, relation, selectedNodeId});
  }, [project, relation, selectedNodeId]);

  return (
    <div className="manager-demo-scene" ref={containerRef}>
      <canvas aria-hidden="true" className="manager-demo-scene-canvas" ref={canvasRef} />
      {rendering === 'loading' ? (
        <div aria-live="polite" className="manager-demo-scene-status" role="status">
          Preparing the graph preview…
        </div>
      ) : null}
      {rendering === 'unavailable' ? (
        <div className="manager-demo-scene-fallback">
          <strong>Graph preview unavailable</strong>
          <span>The node explorer and source details remain available below.</span>
        </div>
      ) : null}
      <div className="sr-only">
        <p>
          Polyglot code graph with TypeScript, Kotlin, Swift, and Java symbols. Solid connections are authoritative;
          muted connections are heuristic.
        </p>
        <ul>
          {EffectArray.map(managerDemoNodes, node => (
            <li key={node.id}>{describeNode(node)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default ManagerGraphScene;
