import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

export function PromptLibraryProductManualInputs({
  specs = [],
  values = {},
  validationErrors = {},
  runAttempted = false,
  onChangeValue = () => {},
}) {
  if (!specs.length) return null;
  return (
    <Box className="prompt-library-product-manual-inputs">
      <Box className="prompt-library-product-manual-inputs-head">
        <Typography variant="caption">补充经营数据（可选）</Typography>
        <Typography variant="caption">有数据就填，没有可留空</Typography>
      </Box>
      <Box className="prompt-library-product-manual-input-grid">
        {specs.map((spec) => {
          const validationError = validationErrors[spec.label];
          return (
            <TextField
              key={spec.label}
              className={`prompt-library-product-manual-input${spec.fullWidth ? ' is-full-width' : ''}`}
              size="small"
              type="number"
              label={spec.label}
              value={values[spec.label] ?? ''}
              placeholder={spec.placeholder}
              error={runAttempted && Boolean(validationError)}
              helperText={runAttempted && validationError ? validationError : ''}
              inputProps={{ min: 0, max: spec.validator === 'percentage' ? 100 : undefined, step: 'any' }}
              onChange={(event) => onChangeValue(spec.label, event.target.value)}
              fullWidth
            />
          );
        })}
      </Box>
    </Box>
  );
}

