import React from 'react';
import { filterObservedAccountRemoval, observeAccountRemovalRow, subscribeAccountRemovalCompletion } from '../services/accountRemovalCompletion.js';

export function useAccountRemovalCompletionView({ rows, ownerTypes, apply }) {
  const currentRef = React.useRef({ rows, ownerTypes, apply });
  currentRef.current = { rows, ownerTypes, apply };
  React.useEffect(() => {
    const observations = new Map();
    return subscribeAccountRemovalCompletion(event => {
      const current = currentRef.current;
      if (!current.ownerTypes.includes(event.owner?.ownerType)) return;
      if (event.type === 'observing') {
        observations.set(event.operationId, observeAccountRemovalRow(current.rows, event));
        if (observations.size > 50) observations.delete(observations.keys().next().value);
      } else {
        const observed = observations.get(event.operationId);
        observations.delete(event.operationId);
        if (observed) current.apply(rowsNow => filterObservedAccountRemoval(rowsNow, observed, event), event);
      }
    });
  }, []);
}
