import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DiffSelection } from '../types/diff';
import { diffSelectionsEqual } from '../utils/diffSelection';

import { RepositoryLauncher } from './RepositoryLauncher';
import { RepositoryWindow } from './RepositoryWindow';
import type { GitEngine } from './gitEngine/gitEngine';
import { buildRepositoryHash, parseRepositoryRoute } from './repositoryRoute';

interface StandaloneAppProps {
  /** Engine factory override for tests; defaults to the real git worker. */
  createEngine?: () => GitEngine;
}

/** The app shell: routes the hash to the launcher or to one repository's window. */
function StandaloneApp({ createEngine }: StandaloneAppProps) {
  const [locationHash, setLocationHash] = useState(() => window.location.hash);

  useEffect(() => {
    const syncHash = () => setLocationHash(window.location.hash);
    window.addEventListener('hashchange', syncHash);
    window.addEventListener('popstate', syncHash);
    return () => {
      window.removeEventListener('hashchange', syncHash);
      window.removeEventListener('popstate', syncHash);
    };
  }, []);

  const route = useMemo(() => parseRepositoryRoute(locationHash), [locationHash]);
  const routeRef = useRef(route);
  routeRef.current = route;

  const handleSelectionChange = useCallback((selection: DiffSelection) => {
    const current = routeRef.current;
    if (!current || diffSelectionsEqual(current.selection, selection)) {
      return;
    }

    const nextHash = buildRepositoryHash(current.folderName, selection);
    // The first resolved selection only makes the address truthful; a reviewer's
    // change is a new diff, so it pushes and Back returns to the previous one.
    if (!current.selection) {
      window.history.replaceState(null, '', nextHash);
      setLocationHash(nextHash);
      return;
    }
    window.location.hash = nextHash;
  }, []);

  if (!route) {
    return <RepositoryLauncher />;
  }

  return (
    <RepositoryWindow
      key={route.folderName}
      folderName={route.folderName}
      routeSelection={route.selection}
      onSelectionChange={handleSelectionChange}
      createEngine={createEngine}
    />
  );
}

export default StandaloneApp;
