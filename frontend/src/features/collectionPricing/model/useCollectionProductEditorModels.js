import React from 'react';

import {
  listSmartToolModelOptions,
  loadSmartToolModelState,
  SMART_TOOL_IMAGE_MODEL_CAPABILITY,
} from '../../promptLibrary/services/smartToolModelService.js';

export function useCollectionProductEditorModels(enabled = false) {
  const [textModelOptions, setTextModelOptions] = React.useState(() => listSmartToolModelOptions());
  const [imageModelOptions, setImageModelOptions] = React.useState(() => (
    listSmartToolModelOptions(undefined, { capability: SMART_TOOL_IMAGE_MODEL_CAPABILITY })
  ));

  React.useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    loadSmartToolModelState()
      .then((state) => {
        if (!active) return;
        setTextModelOptions(listSmartToolModelOptions(state));
        setImageModelOptions(listSmartToolModelOptions(state, { capability: SMART_TOOL_IMAGE_MODEL_CAPABILITY }));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [enabled]);

  return { textModelOptions, imageModelOptions };
}
