import React, {useEffect, useMemo, useRef, useState} from 'react';
import * as THREE from 'three';
import {compareCodeUnits} from '@threadnote/graph/ordering';
import {
  compactNumber,
  FOCUS_LAYOUT_ZOOM,
  graphDisplayEdges,
  graphNodeSizeValues,
  GRAPH_PALETTE,
  MAX_ANIMATED_NEIGHBOR_EDGES,
  MAX_FOCUSED_LABELS,
  MAX_ZOOM,
  MIN_ZOOM,
  SEARCH_FOCUS_ZOOM,
  SELECTED_NODE_COLOR,
  type GraphEdge,
  type GraphFocusMode,
  type GraphLabelSize,
  type GraphLayout,
  type GraphNode,
  type GraphPosition,
  type GraphRuntime,
  type GraphSizeMetric,
  type GraphVisualization,
  type PositionedNode,
  type ViewState,
} from './model.js';

export function ThreeGraph(props: {
  readonly focusRequest?: {readonly nodeId: string; readonly sequence: number};
  readonly focusMode: GraphFocusMode;
  readonly graph: GraphVisualization;
  readonly onOpenProject: (projectId: string) => void;
  readonly onSelectNode: (nodeId: string | undefined) => void;
  readonly relationFilter: string;
  readonly selectedNodeId?: string;
  readonly sizeMetric: GraphSizeMetric;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{moved: boolean; pointerId: number; x: number; y: number} | undefined>(undefined);
  const labelRefs = useRef(new Map<string, HTMLSpanElement>());
  const livePositionsRef = useRef<ReadonlyMap<string, GraphPosition>>(new Map());
  const runtimeRef = useRef<GraphRuntime | undefined>(undefined);
  const [settledPositions, setSettledPositions] = useState<ReadonlyMap<string, GraphPosition>>(() => new Map());
  const [size, setSize] = useState({height: 1, width: 1});
  const sizingEdges = useMemo(
    () =>
      props.relationFilter === 'all'
        ? props.graph.edges
        : props.graph.edges.filter(edge => edge.relation === props.relationFilter),
    [props.graph.edges, props.relationFilter],
  );
  const baseLayout = useMemo(
    () => buildGraphLayout(props.graph, props.sizeMetric, sizingEdges),
    [props.graph, props.sizeMetric, sizingEdges],
  );
  const layout = useMemo(() => graphLayoutWithPositions(baseLayout, settledPositions), [baseLayout, settledPositions]);
  const displayEdges = useMemo(
    () => graphDisplayEdges(props.graph.edges, props.selectedNodeId, props.focusMode, props.relationFilter),
    [props.focusMode, props.graph.edges, props.relationFilter, props.selectedNodeId],
  );
  const neighborhoodEdges = useMemo(
    () =>
      props.selectedNodeId
        ? displayEdges.filter(edge => edge.sourceId === props.selectedNodeId || edge.targetId === props.selectedNodeId)
        : [],
    [displayEdges, props.selectedNodeId],
  );
  const animatedNeighborhoodEdges = useMemo(
    () => neighborhoodEdges.slice(0, MAX_ANIMATED_NEIGHBOR_EDGES),
    [neighborhoodEdges],
  );
  const highlightedNodeIds = useMemo(
    () =>
      props.selectedNodeId
        ? new Set([props.selectedNodeId, ...animatedNeighborhoodEdges.flatMap(edge => [edge.sourceId, edge.targetId])])
        : undefined,
    [animatedNeighborhoodEdges, props.selectedNodeId],
  );
  const activeNodeIds = useMemo(() => {
    if (!props.selectedNodeId || props.focusMode === 'all') return undefined;
    return new Set([props.selectedNodeId, ...displayEdges.flatMap(edge => [edge.sourceId, edge.targetId])]);
  }, [displayEdges, props.focusMode, props.selectedNodeId]);
  const [view, setView] = useState<ViewState>(() => fittedView(layout, size));
  const viewRef = useRef(view);
  const [focusLayoutRevision, setFocusLayoutRevision] = useState(0);
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    setView(fittedView(layout, size));
  }, [props.graph.projectId, props.graph.repository.id, props.graph.repository.snapshot.id, size.height, size.width]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const request = props.focusRequest;
    const node = request ? layout.nodesById.get(request.nodeId) : undefined;
    if (!request || !node) return;
    const startedAt = performance.now();
    const duration = 360;
    const start = viewRef.current;
    const target = graphFocusTarget(start, graphPosition(node, livePositionsRef.current), props.graph.mode);
    let frame = 0;
    const animate = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setView({
        x: lerp(start.x, target.x, eased),
        y: lerp(start.y, target.y, eased),
        zoom: lerp(start.zoom, target.zoom, eased),
      });
      if (progress < 1) frame = window.requestAnimationFrame(animate);
      else setFocusLayoutRevision(current => current + 1);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [props.focusRequest?.sequence, props.graph.mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) setSize({height: Math.max(1, bounds.height), width: Math.max(1, bounds.width)});
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        canvas,
        powerPreference: 'high-performance',
      });
      setRenderError('');
    } catch {
      setRenderError('WebGL is unavailable in this browser. Enable hardware acceleration to render the graph.');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size.width, size.height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();
    updateCamera(camera, view, size);
    const currentPositions = livePositionsRef.current;

    const edgePositions: number[] = [];
    const edgeColors: number[] = [];
    const renderedEdges = displayEdges.filter(
      edge => layout.nodesById.has(edge.sourceId) && layout.nodesById.has(edge.targetId),
    );
    for (const edge of renderedEdges) {
      const source = layout.nodesById.get(edge.sourceId);
      const target = layout.nodesById.get(edge.targetId);
      if (!source || !target) continue;
      const sourcePosition = graphPosition(source, currentPositions);
      const targetPosition = graphPosition(target, currentPositions);
      edgePositions.push(sourcePosition.x, sourcePosition.y, 0, targetPosition.x, targetPosition.y, 0);
      edgeColors.push(source.color.r, source.color.g, source.color.b, target.color.r, target.color.g, target.color.b);
    }
    const edgeGeometry = new THREE.BufferGeometry();
    const edgePosition = new THREE.Float32BufferAttribute(edgePositions, 3);
    edgeGeometry.setAttribute('position', edgePosition);
    edgeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(edgeColors, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      blending: THREE.NormalBlending,
      opacity: props.graph.mode === 'overview' ? 0.5 : 0.32,
      transparent: true,
      vertexColors: true,
    });
    const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    scene.add(lines);

    const positions: number[] = [];
    const colors: number[] = [];
    const pointSizes: number[] = [];
    for (const node of layout.nodes) {
      const color = activeNodeIds && !activeNodeIds.has(node.id) ? node.color.clone().multiplyScalar(0.12) : node.color;
      const position = graphPosition(node, currentPositions);
      positions.push(position.x, position.y, 1);
      colors.push(color.r, color.g, color.b);
      pointSizes.push(node.radius * 2);
    }
    const nodeGeometry = new THREE.BufferGeometry();
    const nodePosition = new THREE.Float32BufferAttribute(positions, 3);
    nodeGeometry.setAttribute('position', nodePosition);
    nodeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    nodeGeometry.setAttribute('pointSize', new THREE.Float32BufferAttribute(pointSizes, 1));
    const nodeMaterial = graphPointMaterial(1, view.zoom);
    const points = new THREE.Points(nodeGeometry, nodeMaterial);
    scene.add(points);

    const renderedHighlightedEdges = animatedNeighborhoodEdges.filter(
      edge => layout.nodesById.has(edge.sourceId) && layout.nodesById.has(edge.targetId),
    );
    const highlightPositions = directionalEdgePositions(renderedHighlightedEdges, layout.nodesById, currentPositions);
    let highlightGeometry: THREE.BufferGeometry | undefined;
    let highlightPosition: THREE.BufferAttribute | undefined;
    let highlightMaterial: THREE.LineBasicMaterial | undefined;
    if (highlightPositions.length > 0) {
      highlightGeometry = new THREE.BufferGeometry();
      highlightPosition = new THREE.Float32BufferAttribute(highlightPositions, 3);
      highlightGeometry.setAttribute('position', highlightPosition);
      highlightMaterial = new THREE.LineBasicMaterial({
        blending: THREE.NormalBlending,
        color: SELECTED_NODE_COLOR,
        opacity: 0.72,
        transparent: true,
      });
      scene.add(new THREE.LineSegments(highlightGeometry, highlightMaterial));
    }

    const selectedNode = props.selectedNodeId ? layout.nodesById.get(props.selectedNodeId) : undefined;
    let selectedGeometry: THREE.BufferGeometry | undefined;
    let selectedPosition: THREE.BufferAttribute | undefined;
    let selectedMaterial: THREE.ShaderMaterial | undefined;
    if (selectedNode) {
      const position = graphPosition(selectedNode, currentPositions);
      selectedGeometry = new THREE.BufferGeometry();
      selectedPosition = new THREE.Float32BufferAttribute([position.x, position.y, 2], 3);
      selectedGeometry.setAttribute('position', selectedPosition);
      selectedGeometry.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(new THREE.Color(SELECTED_NODE_COLOR).toArray(), 3),
      );
      selectedGeometry.setAttribute('pointSize', new THREE.Float32BufferAttribute([selectedNode.radius * 3.3], 1));
      selectedMaterial = graphPointMaterial(1.3, view.zoom);
      scene.add(new THREE.Points(selectedGeometry, selectedMaterial));
    }

    runtimeRef.current = {
      camera,
      edgePosition,
      edges: renderedEdges,
      highlightedEdges: renderedHighlightedEdges,
      highlightPosition,
      nodeIds: layout.nodes.map(node => node.id),
      nodePosition,
      pointMaterials: selectedMaterial ? [nodeMaterial, selectedMaterial] : [nodeMaterial],
      renderer,
      scene,
      selectedNodeId: selectedNode?.id,
      selectedPosition,
    };
    renderer.render(scene, camera);
    return () => {
      runtimeRef.current = undefined;
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      highlightGeometry?.dispose();
      highlightMaterial?.dispose();
      selectedGeometry?.dispose();
      selectedMaterial?.dispose();
      renderer.dispose();
    };
  }, [activeNodeIds, animatedNeighborhoodEdges, displayEdges, layout, props.graph.mode, props.selectedNodeId]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    runtime.renderer.setSize(size.width, size.height, false);
    for (const material of runtime.pointMaterials) {
      const scale = material.uniforms.viewScale;
      if (scale) scale.value = graphPointViewScale(view.zoom);
    }
    updateCamera(runtime.camera, view, size);
    runtime.renderer.render(runtime.scene, runtime.camera);
  }, [size, view]);

  useEffect(() => {
    const currentNodes = baseLayout.nodes.map(node => {
      const settledNode = layout.nodesById.get(node.id) ?? node;
      const position = graphPosition(settledNode, livePositionsRef.current);
      return {...node, x: position.x, y: position.y};
    });
    const labelSizes = new Map<string, GraphLabelSize>();
    for (const [nodeId, element] of labelRefs.current) {
      labelSizes.set(nodeId, {height: element.offsetHeight, width: element.offsetWidth});
    }
    const targets = graphFocusLayoutTargets(
      currentNodes,
      props.selectedNodeId,
      animatedNeighborhoodEdges,
      labelSizes,
      Math.max(FOCUS_LAYOUT_ZOOM, viewRef.current.zoom),
    );
    const simulationIds = new Set([...livePositionsRef.current.keys(), ...settledPositions.keys(), ...targets.keys()]);
    const particles = [...simulationIds].flatMap(nodeId => {
      const baseNode = baseLayout.nodesById.get(nodeId);
      const currentNode = layout.nodesById.get(nodeId) ?? baseNode;
      if (!baseNode || !currentNode) return [];
      const start = livePositionsRef.current.get(nodeId) ?? currentNode;
      const target = targets.get(nodeId) ?? baseNode;
      return [
        {
          id: nodeId,
          targetX: target.x,
          targetY: target.y,
          velocityX: 0,
          velocityY: 0,
          x: start.x,
          y: start.y,
        },
      ];
    });
    const container = containerRef.current;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let frame = 0;
    let lastFrame = performance.now();
    const startedAt = lastFrame;

    const settle = (): void => {
      const resolvedPositions = new Map<string, GraphPosition>();
      for (const particle of particles) {
        resolvedPositions.set(particle.id, {x: particle.targetX, y: particle.targetY});
      }
      applyGraphPositions(runtimeRef.current, resolvedPositions, layout, size, viewRef.current, labelRefs.current);
      const retainedTargets = new Map<string, GraphPosition>();
      for (const [nodeId, target] of targets) {
        const baseNode = baseLayout.nodesById.get(nodeId);
        if (baseNode && Math.hypot(target.x - baseNode.x, target.y - baseNode.y) > 0.01) {
          retainedTargets.set(nodeId, target);
        }
      }
      livePositionsRef.current = retainedTargets;
      setSettledPositions(retainedTargets);
      container?.removeAttribute('data-layout-animating');
    };

    if (
      reducedMotion ||
      particles.every(particle => Math.hypot(particle.targetX - particle.x, particle.targetY - particle.y) < 0.01)
    ) {
      settle();
      return;
    }

    container?.setAttribute('data-layout-animating', 'true');
    const animate = (now: number): void => {
      const delta = Math.min(0.032, Math.max(0.001, (now - lastFrame) / 1000));
      lastFrame = now;
      let movement = 0;
      const positions = new Map<string, GraphPosition>();
      for (const particle of particles) {
        const accelerationX = (particle.targetX - particle.x) * 108 - particle.velocityX * 13;
        const accelerationY = (particle.targetY - particle.y) * 108 - particle.velocityY * 13;
        particle.velocityX += accelerationX * delta;
        particle.velocityY += accelerationY * delta;
        particle.x += particle.velocityX * delta;
        particle.y += particle.velocityY * delta;
        movement = Math.max(
          movement,
          Math.hypot(particle.targetX - particle.x, particle.targetY - particle.y),
          Math.hypot(particle.velocityX, particle.velocityY) * 0.035,
        );
        positions.set(particle.id, {x: particle.x, y: particle.y});
      }
      livePositionsRef.current = positions;
      applyGraphPositions(runtimeRef.current, positions, layout, size, viewRef.current, labelRefs.current);
      if (movement < 0.08 || now - startedAt >= 1250) {
        settle();
        return;
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frame);
      container?.removeAttribute('data-layout-animating');
    };
  }, [animatedNeighborhoodEdges, baseLayout, focusLayoutRevision, props.selectedNodeId]);

  const labels = useMemo(
    () =>
      visibleLabels(
        layout,
        props.graph.mode,
        size,
        view,
        props.selectedNodeId,
        activeNodeIds,
        highlightedNodeIds,
        livePositionsRef.current,
      ),
    [activeNodeIds, highlightedNodeIds, layout, props.graph.mode, props.selectedNodeId, size, view],
  );

  const zoomAt = (factor: number, clientX = size.width / 2, clientY = size.height / 2): void => {
    setView(current => zoomViewAt(current, factor, clientX, clientY, size));
  };

  return (
    <div className="webgl-graph" ref={containerRef}>
      <canvas
        aria-label="Interactive code graph. Drag to pan, scroll to zoom, and click nodes to inspect."
        onDoubleClick={event => {
          const node = nearestNode(
            layout,
            view,
            size,
            event.nativeEvent.offsetX,
            event.nativeEvent.offsetY,
            livePositionsRef.current,
          );
          if (node?.type === 'project') props.onOpenProject(node.projectId);
        }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {moved: false, pointerId: event.pointerId, x: event.clientX, y: event.clientY};
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
          drag.x = event.clientX;
          drag.y = event.clientY;
          setView(current => ({...current, x: current.x - dx / current.zoom, y: current.y + dy / current.zoom}));
        }}
        onPointerUp={event => {
          const drag = dragRef.current;
          if (drag && !drag.moved) {
            const node = nearestNode(
              layout,
              view,
              size,
              event.nativeEvent.offsetX,
              event.nativeEvent.offsetY,
              livePositionsRef.current,
            );
            props.onSelectNode(node?.id);
          }
          dragRef.current = undefined;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onWheel={event => {
          event.preventDefault();
          zoomAt(graphWheelZoomFactor(event.deltaY), event.nativeEvent.offsetX, event.nativeEvent.offsetY);
        }}
        ref={canvasRef}
      />
      <div className="graph-labels" aria-hidden="true">
        {labels.map(label => (
          <span
            className={
              label.node.id === props.selectedNodeId
                ? 'is-selected'
                : highlightedNodeIds?.has(label.node.id)
                  ? 'is-highlighted'
                  : undefined
            }
            data-node-id={label.node.id}
            key={label.node.id}
            ref={element => {
              if (element) labelRefs.current.set(label.node.id, element);
              else labelRefs.current.delete(label.node.id);
            }}
            style={{left: label.x, top: label.y}}
          >
            {label.node.label}
            {label.node.type === 'project' && props.graph.repository.metrics === 'complete' ? (
              <small>{compactNumber(label.node.symbolCount ?? 0)}</small>
            ) : null}
          </span>
        ))}
      </div>
      {renderError ? (
        <div className="graph-empty graph-render-error" role="alert">
          <h3>GPU rendering unavailable</h3>
          <p>{renderError}</p>
        </div>
      ) : null}
      <div className="graph-controls">
        <button aria-label="Zoom in" onClick={() => zoomAt(1.35)} title="Zoom in" type="button">
          +
        </button>
        <button aria-label="Zoom out" onClick={() => zoomAt(1 / 1.35)} title="Zoom out" type="button">
          −
        </button>
        <button
          aria-label="Fit graph"
          onClick={() => setView(fittedView(layout, size))}
          title="Fit graph"
          type="button"
        >
          Fit
        </button>
      </div>
      <div className="zoom-hint">
        <span>{Math.round(view.zoom * 100)}%</span>
        <span>{view.zoom < 1.45 ? 'Zoom in to reveal symbols' : 'Detailed labels visible'}</span>
      </div>
    </div>
  );
}
function buildGraphLayout(
  graph: GraphVisualization,
  sizeMetric: GraphSizeMetric,
  sizingEdges: readonly GraphEdge[],
): GraphLayout {
  const sizeValues = graphNodeSizeValues(sizingEdges, sizeMetric);
  const nodes = graph.mode === 'overview' ? overviewLayout(graph.nodes) : detailLayout(graph.nodes, sizeValues);
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const extentX = Math.max(260, ...nodes.map(node => Math.abs(node.x) + node.radius));
  const extentY = Math.max(200, ...nodes.map(node => Math.abs(node.y) + node.radius));
  return {bounds: {height: extentY * 2.2, width: extentX * 2.2}, nodes, nodesById};
}

function graphLayoutWithPositions(layout: GraphLayout, positions: ReadonlyMap<string, GraphPosition>): GraphLayout {
  if (positions.size === 0) return layout;
  const nodes = layout.nodes.map(node => {
    const position = positions.get(node.id);
    return position ? {...node, x: position.x, y: position.y} : node;
  });
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const extentX = Math.max(260, ...nodes.map(node => Math.abs(node.x) + node.radius));
  const extentY = Math.max(200, ...nodes.map(node => Math.abs(node.y) + node.radius));
  return {bounds: {height: extentY * 2.2, width: extentX * 2.2}, nodes, nodesById};
}

export function graphFocusLayoutTargets(
  nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly radius: number;
    readonly x: number;
    readonly y: number;
  }[],
  selectedNodeId: string | undefined,
  edges: readonly Pick<GraphEdge, 'sourceId' | 'targetId'>[],
  labelSizes: ReadonlyMap<string, {readonly height: number; readonly width: number}> = new Map(),
  zoom = FOCUS_LAYOUT_ZOOM,
): ReadonlyMap<string, GraphPosition> {
  if (!selectedNodeId) return new Map();
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const selectedNode = nodesById.get(selectedNodeId);
  if (!selectedNode) return new Map();
  const neighborIds = new Set<string>();
  for (const edge of edges) {
    if (edge.sourceId === selectedNodeId && nodesById.has(edge.targetId)) neighborIds.add(edge.targetId);
    if (edge.targetId === selectedNodeId && nodesById.has(edge.sourceId)) neighborIds.add(edge.sourceId);
  }
  neighborIds.delete(selectedNodeId);
  const orderedNeighbors = [...neighborIds]
    .map(nodeId => nodesById.get(nodeId))
    .filter(node => node !== undefined)
    .sort((left, right) => compareCodeUnits(left.label, right.label) || compareCodeUnits(left.id, right.id));
  const highlightedIds = new Set([selectedNodeId, ...neighborIds]);
  const visibleObstacles = nodes
    .filter(node => !highlightedIds.has(node.id) && labelSizes.has(node.id))
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .slice(0, 180);
  const focusNodes = [
    {
      anchorX: selectedNode.x,
      anchorY: selectedNode.y,
      fixed: true,
      highlighted: true,
      ...selectedNode,
    },
    ...orderedNeighbors.map(node => ({
      anchorX: node.x,
      anchorY: node.y,
      fixed: false,
      highlighted: true,
      ...node,
    })),
    ...visibleObstacles.map(node => ({
      anchorX: node.x,
      anchorY: node.y,
      fixed: false,
      highlighted: false,
      ...node,
    })),
  ];
  const safeZoom = Math.max(0.5, zoom);
  const animatedNeighbors = focusNodes.filter(node => node.highlighted && !node.fixed);
  const maximumLabelWidth = Math.max(
    72,
    ...animatedNeighbors.map(node => labelSizes.get(node.id)?.width ?? Math.min(150, node.label.length * 6.2)),
  );
  const maximumLabelHeight = Math.max(14, ...animatedNeighbors.map(node => labelSizes.get(node.id)?.height ?? 14));
  const columns = Math.max(2, Math.ceil(Math.sqrt((animatedNeighbors.length + 1) * 0.35)));
  const rows = Math.ceil((animatedNeighbors.length + 1) / columns);
  const cellWidth = (Math.min(150, maximumLabelWidth) + 14) / safeZoom;
  const cellHeight = (maximumLabelHeight + 10) / safeZoom;
  const slots = Array.from({length: rows * columns}, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: (column - (columns - 1) / 2) * cellWidth,
      y: ((rows - 1) / 2 - row) * cellHeight,
    };
  });
  const centerSlot = slots.reduce(
    (closest, slot, index) =>
      Math.hypot(slot.x, slot.y) < closest.distance ? {distance: Math.hypot(slot.x, slot.y), index} : closest,
    {distance: Number.POSITIVE_INFINITY, index: 0},
  );
  slots.splice(centerSlot.index, 1);
  slots.sort(
    (left, right) => Math.hypot(left.x, left.y) - Math.hypot(right.x, right.y) || left.y - right.y || left.x - right.x,
  );
  for (const [index, node] of animatedNeighbors.entries()) {
    const slot = slots[index] ?? {x: 0, y: 0};
    node.x = selectedNode.x + slot.x;
    node.y = selectedNode.y + slot.y;
    node.anchorX = node.x;
    node.anchorY = node.y;
    let deltaX = slot.x;
    let deltaY = slot.y;
    let distance = Math.hypot(deltaX, deltaY);
    const minimumDistance = (selectedNode.radius * 1.25 + node.radius * 1.25 + 22) / safeZoom;
    if (distance < 0.001) {
      const angle = (Math.abs(hashString(node.id)) % 6283) / 1000 + index * 2.399963;
      deltaX = Math.cos(angle);
      deltaY = Math.sin(angle);
      distance = 1;
    }
    if (distance < minimumDistance) {
      node.x = selectedNode.x + (deltaX / distance) * minimumDistance;
      node.y = selectedNode.y + (deltaY / distance) * minimumDistance;
    }
  }

  // Preserve the full relaxation pass for ordinary neighborhoods while bounding
  // maximum-cardinality focus work. Dense graphs benefit more from responsive
  // interaction than from repeatedly refining already-overlapping offscreen labels.
  const collisionIterations = Math.max(10, Math.min(18, Math.floor(5_000 / focusNodes.length)));
  const movableFocusNodes = focusNodes.filter(node => !node.fixed);
  for (let iteration = 0; iteration < collisionIterations; iteration += 1) {
    for (const node of movableFocusNodes) {
      node.x += (node.anchorX - node.x) * 0.006;
      node.y += (node.anchorY - node.y) * 0.006;
    }
    for (const [leftIndex, rightIndex] of focusCollisionPairs(focusNodes, labelSizes, safeZoom)) {
      separateFocusNodes(focusNodes[leftIndex], focusNodes[rightIndex], labelSizes, safeZoom);
    }
    for (const node of animatedNeighbors) {
      const deltaX = node.x - selectedNode.x;
      const deltaY = node.y - selectedNode.y;
      const distance = Math.max(0.001, Math.hypot(deltaX, deltaY));
      const minimumDistance = (selectedNode.radius * 1.25 + node.radius * 1.25 + 22) / safeZoom;
      if (distance < minimumDistance) {
        node.x = selectedNode.x + (deltaX / distance) * minimumDistance;
        node.y = selectedNode.y + (deltaY / distance) * minimumDistance;
      }
    }
  }
  return new Map(focusNodes.map(node => [node.id, {x: node.x, y: node.y}]));
}

function focusCollisionPairs(
  nodes: readonly {
    readonly fixed: boolean;
    readonly highlighted: boolean;
    readonly id: string;
    readonly label: string;
    readonly radius: number;
    readonly x: number;
    readonly y: number;
  }[],
  labelSizes: ReadonlyMap<string, {readonly height: number; readonly width: number}>,
  zoom: number,
): readonly (readonly [number, number])[] {
  const bounds = nodes
    .map((node, index) => {
      const boxes = focusNodeBoxes(node, labelSizes.get(node.id), zoom, node.fixed);
      return {
        bottom: Math.max(...boxes.map(box => box.bottom)),
        highlighted: node.highlighted,
        index,
        left: Math.min(...boxes.map(box => box.left)),
        right: Math.max(...boxes.map(box => box.right)),
        top: Math.min(...boxes.map(box => box.top)),
      };
    })
    .sort((left, right) => left.left - right.left || left.index - right.index);
  const pairs: Array<readonly [number, number]> = [];
  for (const [leftPosition, left] of bounds.entries()) {
    for (let rightPosition = leftPosition + 1; rightPosition < bounds.length; rightPosition += 1) {
      const right = bounds[rightPosition];
      if (right.left >= left.right) break;
      if (!left.highlighted && !right.highlighted) continue;
      if (Math.min(left.bottom, right.bottom) <= Math.max(left.top, right.top)) continue;
      pairs.push([left.index, right.index]);
    }
  }
  return pairs;
}

function separateFocusNodes(
  left: {
    readonly fixed: boolean;
    readonly id: string;
    readonly label: string;
    readonly radius: number;
    x: number;
    y: number;
  },
  right: {
    readonly fixed: boolean;
    readonly id: string;
    readonly label: string;
    readonly radius: number;
    x: number;
    y: number;
  },
  labelSizes: ReadonlyMap<string, {readonly height: number; readonly width: number}>,
  zoom: number,
): void {
  const leftBoxes = focusNodeBoxes(left, labelSizes.get(left.id), zoom, left.fixed);
  const rightBoxes = focusNodeBoxes(right, labelSizes.get(right.id), zoom, right.fixed);
  for (const leftBox of leftBoxes) {
    for (const rightBox of rightBoxes) {
      const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
      const overlapY = Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
      if (overlapX <= 0 || overlapY <= 0) continue;
      const leftCenterX = (leftBox.left + leftBox.right) / 2;
      const leftCenterY = (leftBox.top + leftBox.bottom) / 2;
      const rightCenterX = (rightBox.left + rightBox.right) / 2;
      const rightCenterY = (rightBox.top + rightBox.bottom) / 2;
      const fallback = hashString(`${left.id}:${right.id}`);
      if (overlapX < overlapY) {
        const direction =
          leftCenterX === rightCenterX ? (fallback % 2 === 0 ? -1 : 1) : Math.sign(leftCenterX - rightCenterX);
        moveFocusPair(left, right, direction * (overlapX + 2 / zoom), 0);
      } else {
        const direction =
          leftCenterY === rightCenterY ? (fallback % 2 === 0 ? -1 : 1) : Math.sign(leftCenterY - rightCenterY);
        moveFocusPair(left, right, 0, direction * (overlapY + 2 / zoom));
      }
    }
  }
}

function moveFocusPair(
  left: {readonly fixed: boolean; x: number; y: number},
  right: {readonly fixed: boolean; x: number; y: number},
  deltaX: number,
  deltaY: number,
): void {
  if (left.fixed && right.fixed) return;
  if (left.fixed) {
    right.x -= deltaX;
    right.y -= deltaY;
    return;
  }
  if (right.fixed) {
    left.x += deltaX;
    left.y += deltaY;
    return;
  }
  left.x += deltaX / 2;
  left.y += deltaY / 2;
  right.x -= deltaX / 2;
  right.y -= deltaY / 2;
}

function focusNodeBoxes(
  node: {readonly label: string; readonly radius: number; readonly x: number; readonly y: number},
  measured: {readonly height: number; readonly width: number} | undefined,
  zoom: number,
  selected: boolean,
): readonly {readonly bottom: number; readonly left: number; readonly right: number; readonly top: number}[] {
  const nodeHalfSize = (node.radius * 1.25 + 4) / zoom;
  const estimatedWidth = Math.min(selected ? 300 : 220, Math.max(28, node.label.length * 6.2 + (selected ? 14 : 0)));
  const labelWidth = (measured?.width ?? estimatedWidth) / zoom;
  const labelHeight = (measured?.height ?? (selected ? 22 : 14)) / zoom;
  const labelLeft = node.x + (node.radius + 4) / zoom;
  const margin = 3 / zoom;
  const nodeBox = {
    bottom: node.y + nodeHalfSize + margin,
    left: node.x - nodeHalfSize - margin,
    right: node.x + nodeHalfSize + margin,
    top: node.y - nodeHalfSize - margin,
  };
  if (!measured && !selected) return [nodeBox];
  return [
    nodeBox,
    {
      bottom: node.y + labelHeight / 2 + margin,
      left: labelLeft - margin,
      right: labelLeft + labelWidth + margin,
      top: node.y - labelHeight / 2 - margin,
    },
  ];
}

function overviewLayout(nodes: readonly GraphNode[]): readonly PositionedNode[] {
  const ordered = [...nodes].sort(
    (left, right) =>
      (right.symbolCount ?? right.degree) - (left.symbolCount ?? left.degree) ||
      compareCodeUnits(left.label, right.label),
  );
  return ordered.map((node, index) => {
    const angle = index * 2.399963;
    const ring = index === 0 ? 0 : 78 + Math.sqrt(index) * 84;
    return positionNode(node, Math.cos(angle) * ring, Math.sin(angle) * ring, index);
  });
}

function detailLayout(nodes: readonly GraphNode[], sizeValues: ReadonlyMap<string, number>): readonly PositionedNode[] {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const group = graphGroup(node);
    const items = groups.get(group) ?? [];
    items.push(node);
    groups.set(group, items);
  }
  const orderedGroups = [...groups].sort(
    ([leftName, left], [rightName, right]) => right.length - left.length || compareCodeUnits(leftName, rightName),
  );
  const output: PositionedNode[] = [];
  for (const [groupIndex, [, items]] of orderedGroups.entries()) {
    const groupAngle = groupIndex * 2.399963;
    const groupRadius = orderedGroups.length === 1 ? 0 : 120 + Math.sqrt(groupIndex) * 135;
    const centerX = Math.cos(groupAngle) * groupRadius;
    const centerY = Math.sin(groupAngle) * groupRadius;
    const ordered = [...items].sort(
      (left, right) => right.degree - left.degree || compareCodeUnits(left.label, right.label),
    );
    for (const [itemIndex, node] of ordered.entries()) {
      const angle = itemIndex * 2.399963 + groupAngle;
      const radius = itemIndex === 0 ? 0 : 17 * Math.sqrt(itemIndex);
      output.push(
        positionNode(
          node,
          centerX + Math.cos(angle) * radius,
          centerY + Math.sin(angle) * radius,
          groupIndex,
          sizeValues.get(node.id) ?? 0,
        ),
      );
    }
  }
  return output;
}

function positionNode(
  node: GraphNode,
  x: number,
  y: number,
  colorIndex: number,
  sizeValue = node.degree,
): PositionedNode {
  const radius =
    node.type === 'project'
      ? 8 + Math.min(14, Math.sqrt(Math.max(1, Math.log2((node.symbolCount ?? sizeValue) + 1))) * 3)
      : 4 + Math.min(11, Math.log2(Math.max(0, sizeValue) + 1) * 2);
  return {
    ...node,
    color: new THREE.Color(colorForNode(node, colorIndex)),
    radius,
    x,
    y,
  };
}

function colorForNode(node: GraphNode, fallbackIndex: number): string {
  if (node.type === 'project') return GRAPH_PALETTE[fallbackIndex % GRAPH_PALETTE.length];
  const key = node.projectId || node.kind;
  return GRAPH_PALETTE[Math.abs(hashString(key)) % GRAPH_PALETTE.length];
}

function graphGroup(node: GraphNode): string {
  if (!node.path) return node.projectId;
  const parts = node.path.split('/');
  return parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join('/');
}

function fittedView(layout: GraphLayout, size: {readonly height: number; readonly width: number}): ViewState {
  const padding = 1.12;
  const zoom = Math.min(
    1.6,
    Math.max(
      MIN_ZOOM,
      Math.min(size.width / (layout.bounds.width * padding), size.height / (layout.bounds.height * padding)),
    ),
  );
  return {x: 0, y: 0, zoom: Number.isFinite(zoom) ? zoom : 1};
}

export function graphFocusTarget(
  current: ViewState,
  node: {readonly x: number; readonly y: number},
  mode: GraphVisualization['mode'],
): ViewState {
  const targetZoom = SEARCH_FOCUS_ZOOM[mode];
  const currentZoom = Number.isFinite(current.zoom) ? current.zoom : targetZoom;
  return {
    x: Number.isFinite(node.x) ? node.x : Number.isFinite(current.x) ? current.x : 0,
    y: Number.isFinite(node.y) ? node.y : Number.isFinite(current.y) ? current.y : 0,
    zoom: Math.min(targetZoom * 1.35, Math.max(currentZoom, targetZoom)),
  };
}

export function graphWheelZoomFactor(deltaY: number): number {
  if (Number.isNaN(deltaY)) return 1;
  return Math.max(0.72, Math.min(1.38, Math.exp(-deltaY * 0.0012)));
}

function updateCamera(
  camera: THREE.OrthographicCamera,
  view: ViewState,
  size: {readonly height: number; readonly width: number},
): void {
  camera.left = -size.width / 2 / view.zoom;
  camera.right = size.width / 2 / view.zoom;
  camera.top = size.height / 2 / view.zoom;
  camera.bottom = -size.height / 2 / view.zoom;
  camera.near = 0.1;
  camera.far = 200;
  camera.position.set(view.x, view.y, 100);
  camera.updateProjectionMatrix();
}

function graphPosition(
  node: {readonly id: string; readonly x: number; readonly y: number},
  positions?: ReadonlyMap<string, GraphPosition>,
): GraphPosition {
  return positions?.get(node.id) ?? node;
}

function applyGraphPositions(
  runtime: GraphRuntime | undefined,
  positions: ReadonlyMap<string, GraphPosition>,
  layout: GraphLayout,
  size: {readonly height: number; readonly width: number},
  view: ViewState,
  labelElements: ReadonlyMap<string, HTMLSpanElement>,
): void {
  if (runtime) {
    for (const [index, nodeId] of runtime.nodeIds.entries()) {
      const node = layout.nodesById.get(nodeId);
      if (!node) continue;
      const position = graphPosition(node, positions);
      runtime.nodePosition.setXYZ(index, position.x, position.y, 1);
    }
    runtime.nodePosition.needsUpdate = true;
    for (const [index, edge] of runtime.edges.entries()) {
      const source = layout.nodesById.get(edge.sourceId);
      const target = layout.nodesById.get(edge.targetId);
      if (!source || !target) continue;
      const sourcePosition = graphPosition(source, positions);
      const targetPosition = graphPosition(target, positions);
      runtime.edgePosition.setXYZ(index * 2, sourcePosition.x, sourcePosition.y, 0);
      runtime.edgePosition.setXYZ(index * 2 + 1, targetPosition.x, targetPosition.y, 0);
    }
    runtime.edgePosition.needsUpdate = true;
    if (runtime.highlightPosition) {
      const highlightPositions = directionalEdgePositions(runtime.highlightedEdges, layout.nodesById, positions);
      if (highlightPositions.length === runtime.highlightPosition.array.length) {
        runtime.highlightPosition.array.set(highlightPositions);
        runtime.highlightPosition.needsUpdate = true;
      }
    }
    if (runtime.selectedNodeId && runtime.selectedPosition) {
      const selectedNode = layout.nodesById.get(runtime.selectedNodeId);
      if (selectedNode) {
        const selectedPosition = graphPosition(selectedNode, positions);
        runtime.selectedPosition.setXYZ(0, selectedPosition.x, selectedPosition.y, 2);
        runtime.selectedPosition.needsUpdate = true;
      }
    }
  }

  for (const [nodeId, element] of labelElements) {
    const node = layout.nodesById.get(nodeId);
    if (!node) continue;
    const position = graphPosition(node, positions);
    const x = size.width / 2 + (position.x - view.x) * view.zoom;
    const y = size.height / 2 - (position.y - view.y) * view.zoom;
    element.style.left = `${x + node.radius + 4}px`;
    element.style.top = `${y}px`;
  }
  if (runtime) runtime.renderer.render(runtime.scene, runtime.camera);
}

function zoomViewAt(
  view: ViewState,
  factor: number,
  screenX: number,
  screenY: number,
  size: {readonly height: number; readonly width: number},
): ViewState {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
  const dx = screenX - size.width / 2;
  const dy = screenY - size.height / 2;
  const worldX = view.x + dx / view.zoom;
  const worldY = view.y - dy / view.zoom;
  return {x: worldX - dx / zoom, y: worldY + dy / zoom, zoom};
}

function nearestNode(
  layout: GraphLayout,
  view: ViewState,
  size: {readonly height: number; readonly width: number},
  screenX: number,
  screenY: number,
  positions?: ReadonlyMap<string, GraphPosition>,
): PositionedNode | undefined {
  const worldX = view.x + (screenX - size.width / 2) / view.zoom;
  const worldY = view.y - (screenY - size.height / 2) / view.zoom;
  let selected: PositionedNode | undefined;
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (const node of layout.nodes) {
    const position = graphPosition(node, positions);
    const distance = Math.hypot(position.x - worldX, position.y - worldY);
    const hitRadius = Math.max(node.radius * 1.45, 10 / view.zoom);
    if (distance <= hitRadius && distance < selectedDistance) {
      selected = node;
      selectedDistance = distance;
    }
  }
  return selected;
}

function visibleLabels(
  layout: GraphLayout,
  mode: GraphVisualization['mode'],
  size: {readonly height: number; readonly width: number},
  view: ViewState,
  selectedNodeId?: string,
  activeNodeIds?: ReadonlySet<string>,
  highlightedNodeIds?: ReadonlySet<string>,
  positions?: ReadonlyMap<string, GraphPosition>,
): readonly {readonly node: PositionedNode; readonly x: number; readonly y: number}[] {
  const baseMaximum =
    mode === 'overview'
      ? view.zoom < 0.65
        ? 18
        : 80
      : view.zoom < 0.75
        ? 8
        : view.zoom < 1.45
          ? 24
          : view.zoom < 3
            ? 72
            : 180;
  const highlightedMaximum =
    view.zoom < 0.75
      ? 0
      : view.zoom < 1.45
        ? Math.min(24, highlightedNodeIds?.size ?? 0)
        : Math.min(MAX_FOCUSED_LABELS + 1, highlightedNodeIds?.size ?? 0);
  const maximum = Math.max(baseMaximum, highlightedMaximum);
  let focusedLabelCount = 0;
  return [...layout.nodes]
    .filter(node => !activeNodeIds || activeNodeIds.has(node.id))
    .flatMap(node => {
      const position = graphPosition(node, positions);
      const x = size.width / 2 + (position.x - view.x) * view.zoom;
      const y = size.height / 2 - (position.y - view.y) * view.zoom;
      return x < -80 || x > size.width + 80 || y < -30 || y > size.height + 30 ? [] : [{node, x, y}];
    })
    .sort((left, right) => {
      if (left.node.id === selectedNodeId) return -1;
      if (right.node.id === selectedNodeId) return 1;
      if (highlightedNodeIds?.has(left.node.id) && !highlightedNodeIds.has(right.node.id)) return -1;
      if (highlightedNodeIds?.has(right.node.id) && !highlightedNodeIds.has(left.node.id)) return 1;
      return (
        right.node.degree - left.node.degree ||
        right.node.radius - left.node.radius ||
        compareCodeUnits(left.node.label, right.node.label)
      );
    })
    .filter(({node}) => {
      if (node.id === selectedNodeId || !highlightedNodeIds?.has(node.id)) return true;
      focusedLabelCount += 1;
      return focusedLabelCount <= MAX_FOCUSED_LABELS;
    })
    .map(({node, x, y}) => ({node, x: x + node.radius + 4, y}))
    .slice(0, maximum);
}

function directionalEdgePositions(
  edges: readonly GraphEdge[],
  nodesById: ReadonlyMap<string, PositionedNode>,
  positionOverrides?: ReadonlyMap<string, GraphPosition>,
): readonly number[] {
  const positions: number[] = [];
  for (const edge of edges.slice(0, MAX_ANIMATED_NEIGHBOR_EDGES)) {
    const source = nodesById.get(edge.sourceId);
    const target = nodesById.get(edge.targetId);
    if (!source || !target) continue;
    const sourcePosition = graphPosition(source, positionOverrides);
    const targetPosition = graphPosition(target, positionOverrides);
    let dx = targetPosition.x - sourcePosition.x;
    let dy = targetPosition.y - sourcePosition.y;
    let length = Math.hypot(dx, dy);
    if (length < 0.001) {
      const angle = (Math.abs(hashString(edge.id)) % 6283) / 1000;
      dx = Math.cos(angle) * 0.001;
      dy = Math.sin(angle) * 0.001;
      length = 0.001;
    }
    const unitX = dx / length;
    const unitY = dy / length;
    const tipX = targetPosition.x - unitX * (target.radius + 2);
    const tipY = targetPosition.y - unitY * (target.radius + 2);
    const arrowLength = Math.min(8, Math.max(4, length * 0.16));
    const wingX = tipX - unitX * arrowLength;
    const wingY = tipY - unitY * arrowLength;
    const normalX = -unitY * arrowLength * 0.55;
    const normalY = unitX * arrowLength * 0.55;
    positions.push(
      sourcePosition.x,
      sourcePosition.y,
      1.5,
      tipX,
      tipY,
      1.5,
      tipX,
      tipY,
      1.5,
      wingX + normalX,
      wingY + normalY,
      1.5,
      tipX,
      tipY,
      1.5,
      wingX - normalX,
      wingY - normalY,
      1.5,
    );
  }
  return positions;
}

function graphPointMaterial(scale: number, zoom: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    blending: THREE.NormalBlending,
    depthWrite: false,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 point = gl_PointCoord - vec2(0.5);
        float distanceToCenter = length(point);
        if (distanceToCenter > 0.5) discard;
        float glow = smoothstep(0.5, 0.05, distanceToCenter);
        float core = smoothstep(0.24, 0.05, distanceToCenter);
        gl_FragColor = vec4(vColor + core * 0.32, glow * 0.94);
      }
    `,
    transparent: true,
    uniforms: {
      viewScale: {value: graphPointViewScale(zoom)},
    },
    vertexColors: true,
    vertexShader: `
      attribute float pointSize;
      uniform float viewScale;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_PointSize = max(3.0, pointSize * ${scale.toFixed(2)} * viewScale);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
  });
}

function graphPointViewScale(zoom: number): number {
  return Math.min(1.25, Math.max(0.32, zoom * 0.75));
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}
export function managerGraphClientRenderProxy(
  graph: GraphVisualization,
  size: {readonly height: number; readonly width: number} = {height: 720, width: 1_280},
): {readonly labels: number; readonly matchedEdges: number; readonly nodes: number} {
  const layout = buildGraphLayout(graph, 'connections', graph.edges);
  const view = fittedView(layout, size);
  let matchedEdges = 0;
  for (const edge of graph.edges) {
    if (layout.nodesById.has(edge.sourceId) && layout.nodesById.has(edge.targetId)) matchedEdges += 1;
  }
  return {
    labels: visibleLabels(layout, graph.mode, size, view).length,
    matchedEdges,
    nodes: layout.nodes.length,
  };
}
