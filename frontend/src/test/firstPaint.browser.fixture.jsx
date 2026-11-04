import React from 'react';
import { createRoot } from 'react-dom/client';
import { useOzonRealtimeSnapshot } from '../entities/marketing/marketingSnapshotRuntime.jsx';

// Isolated rendered-hook regression, not a full application/license acceptance.
const source = [{ id: 'first-paint-browser-fixture', clientId: 'fixture', apiKey: 'synthetic-key' }];
window.__firstPaintProof = { cases: {}, complete: false };
function Case({ name, complete, previousRows }) {
  const control = React.useRef({ calls: 0, restarted: false, first: `${name}-first`, last: `${name}-last` });
  const loader = React.useCallback((_source, options) => {
    const c = control.current;
    if (++c.calls === 1) return Promise.resolve({ rows: previousRows, complete });
    return new Promise(resolve => setTimeout(() => {
      options.onInitialSnapshot({ rows: [{ id: c.first }], complete: false });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const output = document.getElementById(name);
        const expected = previousRows.length ? previousRows[0].id : c.first;
        window.__firstPaintProof.cases[name] = {
          partialDom: output.textContent, expected,
          partialPassed: output.textContent === expected
            && output.dataset.complete === String(previousRows.length > 0),
          checkedBeforeFullResolution: true,
        };
        resolve({ rows: [{ id: c.first }, { id: c.last }], complete: true });
      }));
    }, 40));
  }, [complete, name, previousRows]);
  const snapshot = useOzonRealtimeSnapshot(source, loader, {
    refreshOnMount: true, cacheGroup: `browser-${name}`, cacheTtlMs: 60000,
    allowInitialPartialSnapshot: true, keepCurrentDataOnForceRefresh: true,
  });
  React.useEffect(() => {
    const c = control.current;
    if (snapshot.hasLoaded && !c.restarted) {
      c.restarted = true;
      void snapshot.reload({ force: true, loaderForceRefresh: false });
    }
    if (snapshot.hasLoaded && snapshot.data?.rows?.some(row => row.id === c.last)) {
      const proof = window.__firstPaintProof;
      proof.cases[name].fullPassed = document.getElementById(name).textContent === `${c.first},${c.last}`;
      proof.complete = Object.values(proof.cases).length === 3 && Object.values(proof.cases).every(item => item.fullPassed === true);
    }
  }, [name, snapshot]);
  return <output id={name} data-complete={snapshot.data?.complete !== false}>{snapshot.data?.rows?.map(row => row.id).join(',') || ''}</output>;
}
const empty = [];
const previous = [{ id: 'already-visible' }];
createRoot(document.getElementById('root')).render(<>
  <Case name="empty" complete={true} previousRows={empty} />
  <Case name="legacy-empty" previousRows={empty} />
  <Case name="nonempty" complete={true} previousRows={previous} />
</>);
