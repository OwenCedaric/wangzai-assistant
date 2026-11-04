// React datasets are immutable snapshots. Keep derived rows by input-object
// identity and explicit dependencies, never by an unscoped posting number.
export function createPurchaseRowMapper() {
  let owner = null;
  let cache = new WeakMap();
  let previous = [];
  return (rows, scope, dependencies, project) => {
    if (scope !== owner) { owner = scope; cache = new WeakMap(); previous = []; }
    let unchanged = previous.length === rows.length;
    const next = rows.map((row, index) => {
      const values = dependencies(row);
      const existing = cache.get(row);
      let result;
      if (existing && existing.values.length === values.length && values.every((value, i) => Object.is(value, existing.values[i]))) {
        result = existing.result;
      } else {
        result = project(row, values);
        cache.set(row, { values, result });
      }
      if (result !== previous[index]) unchanged = false;
      return result;
    });
    if (!unchanged) previous = next;
    return previous;
  };
}
