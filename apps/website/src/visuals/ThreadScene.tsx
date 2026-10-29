import {Array as EffectArray} from 'effect';
import {useEffect, useRef, useState} from 'react';

type SceneStatus = 'loading' | 'ready' | 'fallback';

export default function ThreadScene() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = (event: MediaQueryListEvent): void => setReducedMotion(event.matches);
    preference.addEventListener('change', updatePreference);
    return () => preference.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || reducedMotion) {
      setStatus('fallback');
      return;
    }
    setStatus('loading');

    let disposed = false;
    let inViewport = true;
    let pageVisible = !document.hidden;
    let frame = 0;
    let intersectionObserver: IntersectionObserver | undefined;
    let cleanupRef: (() => void) | undefined;

    void import('three')
      .then(THREE => {
        if (disposed) return;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
        camera.position.set(0, 0, 9);

        const renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: 'low-power',
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        renderer.setClearColor(0x000000, 0);
        host.append(renderer.domElement);
        renderer.domElement.setAttribute('aria-hidden', 'true');

        const group = new THREE.Group();
        scene.add(group);

        const points = EffectArray.map(
          [
            [-3.4, 1.55, 0],
            [-1.6, 0.95, 0.45],
            [-0.2, 1.6, -0.2],
            [1.3, 0.65, 0.25],
            [3.2, 1.2, -0.1],
            [-2.5, -0.8, -0.25],
            [-0.45, -0.25, 0.5],
            [1.05, -1.35, -0.25],
            [2.8, -0.7, 0.2],
            [-1.4, -2.05, 0.1],
            [0.55, -2.25, -0.45],
          ],
          ([x, y, z]) => new THREE.Vector3(x, y, z),
        );

        const edges = [
          [0, 1],
          [0, 5],
          [1, 2],
          [1, 6],
          [2, 3],
          [3, 4],
          [3, 6],
          [3, 8],
          [5, 6],
          [5, 9],
          [6, 7],
          [6, 9],
          [7, 8],
          [7, 10],
          [9, 10],
        ];

        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setFromPoints(EffectArray.flatMap(edges, ([from, to]) => [points[from], points[to]]));
        const lines = new THREE.LineSegments(
          lineGeometry,
          new THREE.LineBasicMaterial({
            color: 0x67e8c7,
            transparent: true,
            opacity: 0.34,
          }),
        );
        group.add(lines);

        const nodeGeometry = new THREE.IcosahedronGeometry(0.105, 1);
        const colors = [0x67e8c7, 0x7aa2ff, 0xc08cff, 0xffb86b];
        const nodes = EffectArray.map(points, (point, index) => {
          const node = new THREE.Mesh(
            nodeGeometry,
            new THREE.MeshBasicMaterial({
              color: colors[index % colors.length],
              transparent: true,
              opacity: index === 6 ? 1 : 0.82,
            }),
          );
          node.position.copy(point);
          node.scale.setScalar(index === 6 ? 1.8 : 1);
          group.add(node);
          return node;
        });

        const pulseGeometry = new THREE.SphereGeometry(0.055, 10, 10);
        const pulse = new THREE.Mesh(pulseGeometry, new THREE.MeshBasicMaterial({color: 0xffffff}));
        group.add(pulse);

        const resize = () => {
          const width = Math.max(host.clientWidth, 1);
          const height = Math.max(host.clientHeight, 1);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.setSize(width, height, false);
        };
        resize();
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);

        intersectionObserver = new IntersectionObserver(([entry]) => {
          inViewport = entry?.isIntersecting === true;
          if (inViewport) start();
          else stop();
        });
        intersectionObserver.observe(host);

        const onVisibility = () => {
          pageVisible = !document.hidden;
          if (pageVisible) start();
          else stop();
        };
        document.addEventListener('visibilitychange', onVisibility);

        const timer = new THREE.Timer();
        const stop = () => {
          window.cancelAnimationFrame(frame);
          frame = 0;
        };
        const render = () => {
          frame = 0;
          if (disposed || !inViewport || !pageVisible) return;
          timer.update();
          const elapsed = timer.getElapsed();
          group.rotation.y = Math.sin(elapsed * 0.24) * 0.12;
          group.rotation.x = Math.cos(elapsed * 0.18) * 0.035;
          EffectArray.forEach(nodes, (node, index) => {
            const scale = (index === 6 ? 1.7 : 1) + Math.sin(elapsed * 1.5 + index) * 0.12;
            node.scale.setScalar(scale);
          });
          const route = [points[0], points[1], points[6], points[7], points[8]];
          const cursor = (elapsed * 0.34) % (route.length - 1);
          const segment = Math.floor(cursor);
          pulse.position.lerpVectors(route[segment], route[segment + 1], cursor - segment);
          renderer.render(scene, camera);
          frame = window.requestAnimationFrame(render);
        };
        const start = () => {
          if (!frame && !disposed && inViewport && pageVisible) {
            timer.reset();
            frame = window.requestAnimationFrame(render);
          }
        };
        start();
        setStatus('ready');

        return () => {
          disposed = true;
          stop();
          resizeObserver.disconnect();
          intersectionObserver?.disconnect();
          document.removeEventListener('visibilitychange', onVisibility);
          timer.dispose();
          nodeGeometry.dispose();
          pulseGeometry.dispose();
          lineGeometry.dispose();
          EffectArray.forEach(nodes, node => node.material.dispose());
          lines.material.dispose();
          pulse.material.dispose();
          renderer.dispose();
          renderer.forceContextLoss();
          renderer.domElement.remove();
        };
      })
      .then(cleanup => {
        if (!cleanup) return;
        if (disposed) cleanup();
        else cleanupRef = cleanup;
      })
      .catch(() => {
        if (!disposed) setStatus('fallback');
      });

    return () => {
      disposed = true;
      cleanupRef?.();
      intersectionObserver?.disconnect();
    };
  }, [reducedMotion]);

  return (
    <div className={`thread-scene thread-scene--${status}`} ref={hostRef} aria-hidden="true">
      <div className="thread-scene__fallback">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
